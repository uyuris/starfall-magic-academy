// 錬成室 backend B2: the atelier synthesis / farewell / gate / content-result / conversation-gate contract.
// The LLM-backed paths are exercised with a deterministic mock fetchImpl (no live LM), so synthesis atomicity
// and the closed-set face selection are verified end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fixtureRoot, baselineRuntimeState, writeJson, readJson } from './helpers.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { loadHomunculiSurface } from '../src/homunculusSurface.mjs';
import { HOMUNCULUS_FACE_POOL, availableFaceLanes } from '../src/homunculusPool.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions } from '../src/parameters.mjs';
import {
  HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL,
  HOMUNCULUS_NAME_MAX_LENGTH,
  synthesizeHomunculus,
  generateHomunculusParameters,
  farewellHomunculus,
  buildAtelierArrivalView,
  validateHomunculusName,
  nextHomunculusId
} from '../src/homunculusAtelier.mjs';
import { setRelationshipDebugState } from '../src/relationshipState.mjs';
import { addEquipmentInstance, equipItem, loadEquipmentSurface } from '../src/equipment.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import {
  isAtelierUnlocked,
  unlockedGatedDestinationIdsForParameters,
  HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD
} from '../src/homunculusUnlock.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import {
  buildHomunculusContentResult,
  validateRoutingContentResult
} from '../src/routingContentResult.mjs';
import {
  isAtelierConversationSpent,
  readActiveAtelierConversation,
  matchingActiveAtelierConversation,
  ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY,
  ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY
} from '../src/homunculusAtelierVisit.mjs';

const NOW = '2026-07-08T00:00:00.000Z';

// A deterministic LM: canned persona / skeleton / face / farewell / epitaph responses keyed off the prompt.
// The face selection picks the FIRST candidate id listed in the prompt (whatever the closed set actually is),
// so the mock always chooses a valid, used-excluded face without knowing the surface.
function mockLmConfig() {
  return { base_url: 'http://mock.local/v1', chat_model: 'mock-chat', stream: false, timeout_ms: 5000, thinking_effort: null };
}

function cannedFor(prompt) {
  if (prompt.includes('【紹介文の書き方】')) {
    return '紹介文: しずかで優しいテスト用ホムンクルス。錬成室で灯された身を受け止め、創り主のそばにいられることを大切に思っている。\n話し方: 一人称は「わたし」。おだやかに、ゆっくりと話す。';
  }
  if (prompt.includes('人物の種（骨子）を考える')) {
    return 'しずかで夜が似合う。星の残光をながめるのが好きな、少し内向的な気質。';
  }
  if (prompt.includes('候補の顔一覧')) {
    const match = /\bhp_\d{3}\b/.exec(prompt);
    if (!match) throw new Error('mock face selection found no candidate in the prompt');
    return JSON.stringify({ face_id: match[0] });
  }
  if (prompt.includes('別れを告げる')) {
    return 'あなたに灯してもらえて、わたしは本当に幸せでした。一緒に過ごした時間を、決して忘れません。灯が消えても、あなたへの想いは変わりません。どうか、どうか、お元気で。さようなら、わたしの創り主さん。';
  }
  if (prompt.includes('銘（銘文）')) {
    return '静かな夜を愛した、優しい灯。';
  }
  throw new Error(`unexpected mock prompt:\n${prompt.slice(0, 120)}`);
}

function mockFetch() {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    const content = cannedFor(prompt);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

// A fetchImpl that always fails the chat call (unreachable LM) — for the "generation failure spends nothing".
function failingFetch() {
  return async () => {
    const error = new TypeError('fetch failed');
    throw error;
  };
}

const MAGIC_KEYS = magicParameterDefinitions.map((definition) => definition.key);
const ABILITY_KEYS = abilityParameterDefinitions.map((definition) => definition.key);

// A uniform hero parameter block at a single value (raw {value} shape, which the raw-read accepts).
function uniformPlayerParameters(value) {
  return {
    magic: Object.fromEntries(MAGIC_KEYS.map((key) => [key, { value }])),
    abilities: Object.fromEntries(ABILITY_KEYS.map((key) => [key, { value }]))
  };
}

const DEFAULT_PLAYER_PARAMETERS = uniformPlayerParameters(50);

// A rich inventory holding every one of the 24 element×tier dungeon materials (overridable per id), so a
// synthesis can pick any 10-material combination. money is irrelevant now (there is no money cost).
function materialInventory(overrides = {}) {
  const items = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) {
      const itemId = `material_${element}_t${tier}`;
      items.push({ item_id: itemId, quantity: overrides[itemId] ?? 40 });
    }
  }
  return { money: 0, items };
}

// The default synthesis materials arg: exactly 10 (a T4-light stack) — a valid, catalog-real 10-total pick.
const TEN_MATERIALS = [{ item_id: 'material_light_t4', quantity: 10 }];

// A fixed rng (r = 1.0, deterministic ability picks) for synthesis tests that do not assert exact parameters.
const fixedRng = () => 0.5;

// A seeded LCG in [0,1): deterministic (no test flake) yet well-distributed, for the temperature-anchor means.
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// A resolved-material entry as generateHomunculusParameters consumes it (element/tier carried, no catalog read).
function resolvedMaterial(element, tier, quantity) {
  return { item_id: `material_${element}_t${tier}`, quantity, element, tier, name: `${element}_t${tier}` };
}

// The mean of all 11 normalized parameter values.
function parameterMean(parameters) {
  const values = [...Object.values(parameters.magic), ...Object.values(parameters.abilities)].map((entry) => entry.value);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function atelierRoot(t, { elapsedWeeks = 5, inventory = materialInventory(), parameters = DEFAULT_PLAYER_PARAMETERS } = {}) {
  const root = await fixtureRoot('magic-adv-atelier-', {
    runtimeState: { ...baselineRuntimeState, elapsed_weeks: elapsedWeeks }
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'game_data/player_inventory.json', inventory);
  if (parameters) await writeJson(root, 'game_data/runtime/player_parameters.json', parameters);
  return root;
}

async function actorDirExists(root, homunculusId) {
  try {
    await fs.access(path.join(root, 'game_data/homunculi', homunculusId, 'profile.json'));
    return true;
  } catch {
    return false;
  }
}

// ----- gate (unlock, dispatch, meta context) -----

test('the atelier destination is fail-closed: absent from the candidate set until unlocked', () => {
  const locked = routingDestinationsForState({ elapsed_weeks: 5 }).map((d) => d.id);
  assert.ok(!locked.includes('homunculus'), 'homunculus must not appear without an unlock');
  const unlocked = routingDestinationsForState({ elapsed_weeks: 5 }, ['homunculus']).map((d) => d.id);
  assert.ok(unlocked.includes('homunculus'), 'homunculus appears once unlocked');
  // Everything else about the non-unlocked set is byte-identical to the pre-gate catalog order.
  assert.deepEqual(locked, unlocked.filter((id) => id !== 'homunculus'));
});

test('the unlock predicate fires at the magic threshold and is fail-closed otherwise', () => {
  assert.equal(HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD, 80);
  const below = { magic: { fire: { value: HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD - 1 } } };
  const at = { magic: { fire: { value: HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } } };
  assert.equal(isAtelierUnlocked(below), false);
  assert.equal(isAtelierUnlocked(at), true);
  assert.deepEqual(unlockedGatedDestinationIdsForParameters(below), []);
  assert.deepEqual(unlockedGatedDestinationIdsForParameters(at), ['homunculus']);
  assert.deepEqual(unlockedGatedDestinationIdsForParameters(null), []);
  // Bare-number shape is accepted too.
  assert.equal(isAtelierUnlocked({ magic: { earth: 95 } }), true);
});

test('the atelier destination dispatches to academy-atelier', () => {
  const dispatch = resolveRoutingDestinationDispatch('homunculus');
  assert.equal(dispatch.next_screen, 'academy-atelier');
  assert.equal(dispatch.destination_id, 'homunculus');
});

test('the routing meta-context renders the atelier only when the hub context unlocks it', () => {
  const state = { ...baselineRuntimeState, elapsed_weeks: 5 };
  const baseHub = {
    persona_variant: 'fallen_star',
    recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
    relationship_context: { buddy: null, enemies: [] },
    alchemy_context: { recipe_count: 8 },
    study_circle_context: { theme_count: 20, weekly_offer_count: 3 },
    content_result_context: null
  };
  const locked = buildRoutingMetaContext({ state, routingHubContext: baseHub });
  assert.ok(!locked.includes('錬成室'), 'locked hub must not mention the atelier');
  const unlocked = buildRoutingMetaContext({ state, routingHubContext: { ...baseHub, unlocked_gated_destination_ids: ['homunculus'] } });
  assert.ok(unlocked.includes('錬成室'), 'unlocked hub lists the atelier');
});

test('buildRoutingHubContextSnapshot stamps the unlock derived from live player parameters', async (t) => {
  const unlockedRoot = await atelierRoot(t, { parameters: { magic: { light: { value: 88 } }, abilities: {} } });
  const lockedRoot = await atelierRoot(t, { parameters: { magic: { light: { value: 40 } }, abilities: {} } });
  const state = await readJson(unlockedRoot, 'game_data/runtime_state.json');
  const unlockedSnap = await buildRoutingHubContextSnapshot({ root: unlockedRoot, state, personaVariant: 'fallen_star' });
  const lockedSnap = await buildRoutingHubContextSnapshot({ root: lockedRoot, state: await readJson(lockedRoot, 'game_data/runtime_state.json'), personaVariant: 'fallen_star' });
  assert.deepEqual(unlockedSnap.unlocked_gated_destination_ids, ['homunculus']);
  assert.deepEqual(lockedSnap.unlocked_gated_destination_ids, []);
});

// ----- content result kind -----

test('the homunculus content result validates for all three triggers and round-trips', () => {
  const created = buildHomunculusContentResult({ week: 5, now: NOW, action: 'created', homunculusId: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_007' });
  assert.equal(created.trigger, 'homunculus_created');
  assert.equal(created.detail.action, 'created');
  assert.deepEqual(validateRoutingContentResult(created), created);

  const talked = buildHomunculusContentResult({ week: 5, now: NOW, action: 'conversation', homunculusId: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_007' });
  assert.equal(talked.trigger, 'homunculus_conversation_completed');

  const farewell = buildHomunculusContentResult({ week: 5, now: NOW, action: 'farewell', homunculusId: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_007', epitaph: '静かに眠れ' });
  assert.equal(farewell.trigger, 'homunculus_farewelled');
  assert.equal(farewell.detail.epitaph, '静かに眠れ');
});

test('the homunculus content result fails fast on malformed detail', () => {
  assert.throws(() => buildHomunculusContentResult({ week: 5, now: NOW, action: 'created', homunculusId: 'bad_id', displayName: 'x', faceId: 'hp_007' }), /homunculus_NNN/);
  assert.throws(() => buildHomunculusContentResult({ week: 5, now: NOW, action: 'created', homunculusId: 'homunculus_001', displayName: 'x', faceId: 'face_007' }), /hp_NNN/);
  // A farewell record missing its epitaph, or a non-farewell record carrying one, is corrupt.
  assert.throws(() => validateRoutingContentResult({
    kind: 'homunculus', destination_id: 'homunculus', trigger: 'homunculus_farewelled', week: 5, recorded_at: NOW,
    detail: { action: 'farewell', homunculus_id: 'homunculus_001', display_name: 'x', face_id: 'hp_007' }
  }), /epitaph/);
  assert.throws(() => validateRoutingContentResult({
    kind: 'homunculus', destination_id: 'homunculus', trigger: 'homunculus_created', week: 5, recorded_at: NOW,
    detail: { action: 'created', homunculus_id: 'homunculus_001', display_name: 'x', face_id: 'hp_007', epitaph: 'x' }
  }), /unexpected key/);
});

test('the hub meta-context renders a homunculus content result so ルミ can touch on it next week', () => {
  const state = { ...baselineRuntimeState, elapsed_weeks: 5 };
  const hubWith = (record) => ({
    persona_variant: 'fallen_star',
    unlocked_gated_destination_ids: ['homunculus'],
    recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
    relationship_context: { buddy: null, enemies: [] },
    alchemy_context: { recipe_count: 8 },
    study_circle_context: { theme_count: 20, weekly_offer_count: 3 },
    content_result_context: { record, companion: null }
  });
  const created = buildHomunculusContentResult({ week: 5, now: NOW, action: 'created', homunculusId: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_007' });
  assert.ok(buildRoutingMetaContext({ state, routingHubContext: hubWith(created) }).includes('ホムンクルスヴィオラ（homunculus_001）を錬成'));
  const farewell = buildHomunculusContentResult({ week: 5, now: NOW, action: 'farewell', homunculusId: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_007', epitaph: '静かに眠れ' });
  assert.ok(buildRoutingMetaContext({ state, routingHubContext: hubWith(farewell) }).includes('別れを告げた。銘: 静かに眠れ'));
});

// ----- face pool / closed set -----

test('the face pool holds exactly 50 dense lanes and excludes used faces', () => {
  assert.equal(HOMUNCULUS_FACE_POOL.length, 50);
  const surface = { active: [{ face_id: 'hp_001' }], nameplates: [{ face_id: 'hp_050' }] };
  const available = availableFaceLanes(surface).map((lane) => lane.id);
  assert.ok(!available.includes('hp_001'), 'active face excluded');
  assert.ok(!available.includes('hp_050'), 'nameplate face excluded');
  assert.equal(available.length, 48);
});

// ----- name validation -----

test('name validation accepts real names and rejects empty / too-long / bracketed / control', () => {
  assert.equal(validateHomunculusName('  ヴィオラ  '), 'ヴィオラ');
  assert.throws(() => validateHomunculusName(''), /must not be empty/);
  assert.throws(() => validateHomunculusName('あ'.repeat(HOMUNCULUS_NAME_MAX_LENGTH + 1)), /at most/);
  assert.throws(() => validateHomunculusName('ノクス『闇』'), /bracket/);
  assert.throws(() => validateHomunculusName('bad\nname'), /control/);
});

// ----- visit / 1-conversation gate -----

test('the 1-visit-1-conversation gate is week-keyed and marker-aware', () => {
  const base = { ...baselineRuntimeState, elapsed_weeks: 5 };
  assert.equal(isAtelierConversationSpent(base, 5), false);
  const active = { ...base, [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: { conversation_id: 'conv_atelier_x', homunculus_id: 'homunculus_001', display_name: 'ヴィオラ', face_id: 'hp_007', week: 5 } };
  assert.equal(isAtelierConversationSpent(active, 5), true, 'an active conversation spends the visit');
  assert.deepEqual(readActiveAtelierConversation(active).homunculus_id, 'homunculus_001');
  const completed = { ...base, [ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY]: 5 };
  assert.equal(isAtelierConversationSpent(completed, 5), true, 'completed this week spends the visit');
  assert.equal(isAtelierConversationSpent(completed, 6), false, 'a new week (new visit) is fresh');
});

test('matchingActiveAtelierConversation is non-interfering and fails fast on actor mismatch', () => {
  const marker = { conversation_id: 'conv_atelier_x', homunculus_id: 'homunculus_001', display_name: 'ヴィオラ', face_id: 'hp_007', week: 5 };
  const state = { ...baselineRuntimeState, [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: marker };
  assert.equal(matchingActiveAtelierConversation({ state, conversationId: 'conv_other', characterId: 'character_003' }), null, 'a different conversation is untouched');
  assert.deepEqual(matchingActiveAtelierConversation({ state, conversationId: 'conv_atelier_x', characterId: 'homunculus_001' }), marker);
  assert.throws(() => matchingActiveAtelierConversation({ state, conversationId: 'conv_atelier_x', characterId: 'homunculus_999' }), /actor mismatch/);
});

// An auction-adopted being (競売場の子) carries an ab_NNN face on the same 錬成室 surface. Its atelier
// conversation must start, run, and finalize identically to an hp_NNN child — the marker read/match and the
// conversation-end content result accept the ab_ face, not just hp_. (Regression: the marker validator once
// rejected ab_ faces with "requires a hp_NNN face_id".)
test('an ab_NNN auction being drives an atelier conversation exactly like an hp_NNN child', () => {
  const marker = { conversation_id: 'conv_atelier_ab', homunculus_id: 'homunculus_014', display_name: 'サラマンダー', face_id: 'ab_003', week: 5 };
  const state = { ...baselineRuntimeState, [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: marker };
  // start / read: a present ab_ marker validates and reads back intact.
  assert.deepEqual(readActiveAtelierConversation(state), marker);
  assert.equal(isAtelierConversationSpent(state, 5), true, 'an active ab_ conversation spends the visit');
  // turn / finalization: the actor matcher recognizes the ab_ conversation.
  assert.deepEqual(matchingActiveAtelierConversation({ state, conversationId: 'conv_atelier_ab', characterId: 'homunculus_014' }), marker);
  // conversation-end content result: the completed record accepts the ab_ face.
  const talked = buildHomunculusContentResult({ week: 5, now: NOW, action: 'conversation', homunculusId: 'homunculus_014', displayName: 'サラマンダー', faceId: 'ab_003' });
  assert.equal(talked.detail.face_id, 'ab_003');
  assert.deepEqual(validateRoutingContentResult(talked), talked);
});

// ----- synthesis (atomic) -----

test('manual synthesis seeds the actor + surface and consumes exactly the 10 chosen materials (no money)', async (t) => {
  const root = await atelierRoot(t);
  const result = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: '臆病で甘えん坊。', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  assert.equal(result.homunculus.homunculus_id, 'homunculus_001');
  assert.match(result.homunculus.face_id, /^hp_\d{3}$/);
  assert.equal(result.content_result.trigger, 'homunculus_created');

  const storage = createStorageApi({ root });
  const surface = await loadHomunculiSurface({ storage });
  assert.equal(surface.active.length, 1);
  assert.equal(surface.active[0].homunculus_id, 'homunculus_001');
  assert.equal(surface.active[0].created_week, 5);

  const profile = await readJson(root, 'game_data/homunculi/homunculus_001/profile.json');
  assert.equal(profile.character_id, 'homunculus_001');
  assert.equal(profile.visual_set_id, result.homunculus.face_id);
  assert.ok(profile.prompt_description && profile.speaking_basis);

  // No money cost, and only the 10 chosen materials (material_light_t4 ×10) leave the ledger.
  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 0);
  assert.equal(inventory.items.find((i) => i.item_id === 'material_light_t4').quantity, 40 - 10);
  for (const item of inventory.items) {
    if (item.item_id !== 'material_light_t4') assert.equal(item.quantity, 40, `${item.item_id} untouched`);
  }

  // consumed_costs reflects the chosen materials and carries the catalog display name (not the item_id).
  assert.deepEqual(result.consumed_costs.item_costs.map((c) => ({ item_id: c.item_id, quantity: c.quantity })), [{ item_id: 'material_light_t4', quantity: 10 }]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.consumed_costs, 'money_cost'), false, 'no money_cost key remains');
  const consumedName = result.consumed_costs.item_costs[0].name;
  assert.ok(typeof consumedName === 'string' && consumedName.length > 0 && consumedName !== 'material_light_t4', 'consumed cost carries a display name');
});

test('synthesis writes normalized parameters to the profile and the result homunculus (deterministic rng)', async (t) => {
  const root = await atelierRoot(t);
  const result = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  const profile = await readJson(root, 'game_data/homunculi/homunculus_001/profile.json');

  // The profile parameters are the C-12 normalized shape (6 magic + 5 ability keys, each {min,max,label,value}).
  assert.deepEqual(Object.keys(profile.parameters.magic).sort(), [...MAGIC_KEYS].sort());
  assert.deepEqual(Object.keys(profile.parameters.abilities).sort(), [...ABILITY_KEYS].sort());
  for (const group of ['magic', 'abilities']) {
    for (const entry of Object.values(profile.parameters[group])) {
      assert.equal(entry.min, 0);
      assert.equal(entry.max, 100);
      assert.equal(typeof entry.label, 'string');
      assert.ok(Number.isInteger(entry.value) && entry.value >= 0 && entry.value <= 100);
    }
  }
  // The result homunculus carries the same parameters block the profile stored.
  assert.deepEqual(result.homunculus.parameters, profile.parameters);

  // Deterministic from hero=50, 10×T4-light, fixedRng (r=1.0, picks strength/magical_power/agility per material):
  // base = floor(0.4×50)=20; light += 26×10 → clamp(20+260)=100; str/mp/agi += 6×10=60 → clamp(20+60)=80.
  assert.equal(profile.parameters.magic.light.value, 100);
  assert.equal(profile.parameters.magic.dark.value, 20);
  assert.equal(profile.parameters.abilities.strength.value, 80);
  assert.equal(profile.parameters.abilities.magical_power.value, 80);
  assert.equal(profile.parameters.abilities.agility.value, 80);
  assert.equal(profile.parameters.abilities.academics.value, 20);
});

test('omakase synthesis generates a skeleton then a persona (name only)', async (t) => {
  const root = await atelierRoot(t);
  const result = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'omakase', name: 'ノクス', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  assert.equal(result.mode, 'omakase');
  assert.equal(result.homunculus.display_name, 'ノクス');
  const profile = await readJson(root, 'game_data/homunculi/homunculus_001/profile.json');
  assert.ok(profile.prompt_description.length > 0);
});

test('a used face is never selected twice within a save', async (t) => {
  const root = await atelierRoot(t);
  const first = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'いち', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  const second = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'に', skeleton: 'y', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  assert.notEqual(first.homunculus.face_id, second.homunculus.face_id, 'the second child gets a different face');
  assert.equal(second.homunculus.homunculus_id, 'homunculus_002');
});

test('a full roster fails fast before consuming anything', async (t) => {
  const root = await atelierRoot(t);
  for (const name of ['a', 'b', 'c']) {
    await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name, skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  }
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'd', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW }),
    (error) => error.statusCode === 409 && error.errorCode === 'HOMUNCULUS_ROSTER_FULL'
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before, 'a full-roster reject spends nothing');
});

// ----- material validation (fail-fast before generation, LLM never called) -----

test('material validation fail-fasts before any generation on a bad total / unknown id / bad quantity / non-array', async (t) => {
  const root = await atelierRoot(t);
  // failingFetch throws if a generation call is ever made, so a rejection proves the pre-check fired first.
  const badMaterials = [
    { label: 'total below 10', materials: [{ item_id: 'material_light_t4', quantity: 9 }] },
    { label: 'total above 10', materials: [{ item_id: 'material_light_t4', quantity: 11 }] },
    { label: 'empty', materials: [] },
    { label: 'unknown id', materials: [{ item_id: 'material_void_t4', quantity: 10 }] },
    { label: 'zero quantity', materials: [{ item_id: 'material_light_t4', quantity: 10 }, { item_id: 'material_dark_t1', quantity: 0 }] },
    { label: 'non-integer quantity', materials: [{ item_id: 'material_light_t4', quantity: 2.5 }] },
    { label: 'non-array', materials: 'nope' }
  ];
  for (const { label, materials } of badMaterials) {
    await assert.rejects(
      synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials, rng: fixedRng, now: NOW }),
      (error) => error.statusCode === 400 && error.errorCode === 'HOMUNCULUS_MATERIALS_INVALID',
      label
    );
  }
  assert.equal((await loadHomunculiSurface({ storage: createStorageApi({ root }) })).active.length, 0);
});

test('duplicate material entries are summed to reach the total of 10', async (t) => {
  const root = await atelierRoot(t);
  const duplicated = [
    { item_id: 'material_light_t4', quantity: 4 },
    { item_id: 'material_light_t4', quantity: 6 }
  ];
  const result = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: duplicated, rng: fixedRng, now: NOW });
  // The two entries combine into one 10-quantity consumed cost.
  assert.deepEqual(result.consumed_costs.item_costs.map((c) => ({ item_id: c.item_id, quantity: c.quantity })), [{ item_id: 'material_light_t4', quantity: 10 }]);
  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.items.find((i) => i.item_id === 'material_light_t4').quantity, 40 - 10);
});

test('an insufficient-material synthesis fails fast before any generation and spends nothing', async (t) => {
  // Own only 3 of the requested 10 material_light_t4 (every other material also short of 10).
  const root = await atelierRoot(t, { inventory: { money: 0, items: [{ item_id: 'material_light_t4', quantity: 3 }] } });
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW }),
    /insufficient_item_quantity/
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before);
  assert.equal((await loadHomunculiSurface({ storage: createStorageApi({ root }) })).active.length, 0);
});

test('synthesis fails fast when the rng seam is missing (no silent Math.random fallback)', async (t) => {
  const root = await atelierRoot(t);
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, now: NOW }),
    /rng function is required/
  );
});

test('synthesis fails fast when player parameters are absent (raw read, no default fill)', async (t) => {
  const root = await atelierRoot(t, { parameters: null });
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW }),
    /player parameters are required/
  );
});

test('a generation failure leaves materials unconsumed and no actor directory', async (t) => {
  const root = await atelierRoot(t);
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW })
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before, 'materials untouched on generation failure');
  assert.equal(await actorDirExists(root, 'homunculus_001'), false, 'no actor directory seeded');
  assert.equal((await loadHomunculiSurface({ storage: createStorageApi({ root }) })).active.length, 0);
});

test('synthesis does not spend the visit conversation gate (錬成→初会話 continuity)', async (t) => {
  const root = await atelierRoot(t);
  await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  const state = await readJson(root, 'game_data/runtime_state.json');
  // Synthesis touches the surface / actor / inventory, never the conversation gate — so the freshly minted
  // child can be talked to in the same visit.
  assert.equal(isAtelierConversationSpent(state, 5), false);
  assert.equal(readActiveAtelierConversation(state), null);
});

// ----- parameter generation formula + temperature anchors -----

test('generateHomunculusParameters applies base + round(r × bonus) with tier tables (deterministic)', () => {
  const zeroRng = () => 0; // r = 0.5; every material picks agility / academics / magical_power.
  // hero all 100, 10×T4 light: base 40; light += 26×10 → clamp(40+130)=100; agi/aca/mp += 6×10=60 → 40+30=70.
  const t4 = generateHomunculusParameters({ playerParameters: uniformPlayerParameters(100), materials: [resolvedMaterial('light', 4, 10)], rng: zeroRng });
  assert.equal(t4.magic.light.value, 100);
  for (const key of ['dark', 'fire', 'water', 'earth', 'wind']) assert.equal(t4.magic[key].value, 40);
  for (const key of ['agility', 'academics', 'magical_power']) assert.equal(t4.abilities[key].value, 70);
  for (const key of ['strength', 'charisma']) assert.equal(t4.abilities[key].value, 40);

  // hero all 0, 10×T1 fire: base 0; fire += 3×10=30 → round(0.5×30)=15; agi/aca/mp += 1×10=10 → round(0.5×10)=5.
  const t1 = generateHomunculusParameters({ playerParameters: uniformPlayerParameters(0), materials: [resolvedMaterial('fire', 1, 10)], rng: zeroRng });
  assert.equal(t1.magic.fire.value, 15);
  for (const key of ['light', 'dark', 'water', 'earth', 'wind']) assert.equal(t1.magic[key].value, 0);
  for (const key of ['agility', 'academics', 'magical_power']) assert.equal(t1.abilities[key].value, 5);
  for (const key of ['strength', 'charisma']) assert.equal(t1.abilities[key].value, 0);
});

test('generateHomunculusParameters fails fast without an rng seam', () => {
  assert.throws(
    () => generateHomunculusParameters({ playerParameters: uniformPlayerParameters(50), materials: [resolvedMaterial('light', 4, 10)] }),
    /rng function is required/
  );
});

test('generateHomunculusParameters fails fast on a missing hero parameter key (raw read)', () => {
  const missing = { magic: { light: { value: 50 } }, abilities: { strength: { value: 50 } } };
  assert.throws(
    () => generateHomunculusParameters({ playerParameters: missing, materials: [resolvedMaterial('light', 4, 10)], rng: () => 0.5 }),
    /player parameter .* is required/
  );
});

test('the temperature anchors hold from the tunable constants (seeded-mean over many synths)', () => {
  const balancedT4 = [resolvedMaterial('light', 4, 2), resolvedMaterial('dark', 4, 2), resolvedMaterial('fire', 4, 2), resolvedMaterial('water', 4, 2), resolvedMaterial('earth', 4, 1), resolvedMaterial('wind', 4, 1)];
  const balancedT1 = [resolvedMaterial('light', 1, 2), resolvedMaterial('dark', 1, 2), resolvedMaterial('fire', 1, 2), resolvedMaterial('water', 1, 2), resolvedMaterial('earth', 1, 1), resolvedMaterial('wind', 1, 1)];
  const anchorMean = (heroValue, materials, seed) => {
    const rng = seededRng(seed);
    const samples = 600;
    let total = 0;
    for (let i = 0; i < samples; i += 1) {
      total += parameterMean(generateHomunculusParameters({ playerParameters: uniformPlayerParameters(heroValue), materials, rng }));
    }
    return total / samples;
  };
  // Anchors (Lead 指定 2026-07-08): hero-max + T4 ≈ 80; hero-0 + T4 ≈ 40; hero-max + T1 ≈ 40台前半.
  const heroMaxT4 = anchorMean(100, balancedT4, 101);
  const heroZeroT4 = anchorMean(0, balancedT4, 202);
  const heroMaxT1 = anchorMean(100, balancedT1, 303);
  assert.ok(heroMaxT4 >= 72 && heroMaxT4 <= 86, `hero-max T4 mean ${heroMaxT4} near 80`);
  assert.ok(heroZeroT4 >= 33 && heroZeroT4 <= 47, `hero-0 T4 mean ${heroZeroT4} near 40`);
  assert.ok(heroMaxT1 >= 40 && heroMaxT1 <= 50, `hero-max T1 mean ${heroMaxT1} in the low 40s`);
});

// ----- farewell -----

test('farewell generates a speech + epitaph, frees the slot, and keeps the face excluded', async (t) => {
  const root = await atelierRoot(t);
  const created = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  const faceId = created.homunculus.face_id;

  const farewell = await farewellHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), homunculusId: 'homunculus_001', now: NOW });
  assert.ok(farewell.farewell_speech.length > 0 && farewell.farewell_speech.length <= 1000);
  assert.ok(farewell.epitaph.length > 0);
  assert.equal(farewell.content_result.trigger, 'homunculus_farewelled');

  const storage = createStorageApi({ root });
  const surface = await loadHomunculiSurface({ storage });
  assert.equal(surface.active.length, 0, 'slot freed');
  assert.equal(surface.nameplates.length, 1);
  assert.equal(surface.nameplates[0].face_id, faceId);
  assert.equal(surface.nameplates[0].epitaph, farewell.epitaph);

  // The farewelled face stays excluded from future candidates, and the id is not reused.
  assert.ok(!availableFaceLanes(surface).some((lane) => lane.id === faceId));
  assert.equal(nextHomunculusId(surface), 'homunculus_002');
});

test('farewell of a non-active homunculus fails fast', async (t) => {
  const root = await atelierRoot(t);
  await assert.rejects(
    farewellHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), homunculusId: 'homunculus_009', now: NOW }),
    (error) => error.statusCode === 404 && error.errorCode === 'HOMUNCULUS_NOT_ACTIVE'
  );
});

// ----- arrival view -----

test('the arrival view reports active children (with parameters), nameplates, and the 24-material picker', async (t) => {
  const root = await atelierRoot(t);
  const created = await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  const view = await buildAtelierArrivalView({ root });
  assert.equal(view.active.length, 1);
  assert.equal(view.active[0].display_name, 'ヴィオラ');
  assert.match(view.active[0].face_url, /\/canonical\/character_visual_sets\/hp_\d{3}\/face_emotions\/neutral\.jpg$/);
  // The active child exposes its parameters (normalized shape, matching what synthesis wrote).
  assert.deepEqual(view.active[0].parameters, created.homunculus.parameters);
  assert.equal(view.active[0].parameters.magic.light.value, 100);

  // No legacy cost preview; the arrival now exposes the material picker + the required total.
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'cost'), false);
  assert.equal(view.required_material_total, HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL);
  assert.equal(view.materials.length, MATERIAL_ELEMENTS.length * MATERIAL_TIERS.length, 'all 24 materials listed');
  const light4 = view.materials.find((m) => m.item_id === 'material_light_t4');
  assert.equal(light4.held, 40 - 10, 'held reflects the post-synthesis ledger');
  assert.equal(light4.element, 'light');
  assert.equal(light4.tier, 4);
  assert.ok(typeof light4.name === 'string' && light4.name.length > 0 && light4.name !== light4.item_id, 'material carries a display name');
  assert.equal(view.can_synthesize, true);
});

test('the arrival view marks the active child as is_buddy when it is the current buddy', async (t) => {
  const root = await atelierRoot(t);
  await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  // No buddy: is_buddy is false.
  assert.equal((await buildAtelierArrivalView({ root })).active[0].is_buddy, false);
  // Set the homunculus as the current buddy: the arrival view marks it.
  await setRelationshipDebugState({ root, buddyCharacterId: 'homunculus_001', enemyCharacterIds: [] });
  assert.equal((await buildAtelierArrivalView({ root })).active[0].is_buddy, true);
});

test('farewell clears a current-buddy pointer and its companion equipment slot (no dangling references)', async (t) => {
  const root = await atelierRoot(t);
  await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'ヴィオラ', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  // Make it the buddy and equip a weapon onto it.
  await setRelationshipDebugState({ root, buddyCharacterId: 'homunculus_001', enemyCharacterIds: [] });
  await addEquipmentInstance({ root, instance: {
    instance_id: 'wpn_hom', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 1, quality: 'common',
    name: '鉄剣', flavor: 'x', base_effects: { attack: 3 }, bonus_effects: {}
  } });
  await equipItem({ root, target: 'homunculus_001', slot: 'weapon', instance_id: 'wpn_hom' });
  const beforeState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(beforeState.current_buddy_character_id, 'homunculus_001');
  assert.deepEqual(beforeState.companion_equipment_slots, { homunculus_001: { weapon: 'wpn_hom' } });

  await farewellHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), homunculusId: 'homunculus_001', now: NOW });

  const afterState = await readJson(root, 'game_data/runtime_state.json');
  // The buddy pointer, the actor buddy flag, and the companion equipment slot are all cleared.
  assert.equal(afterState.current_buddy_character_id, null);
  assert.equal(Object.prototype.hasOwnProperty.call(afterState, 'companion_equipment_slots'), false);
  assert.equal(afterState.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], false);
  assert.equal((await readJson(root, 'game_data/homunculi/homunculus_001/flags.json')).flags['relationship.homunculus_001.buddy'], false);
  // The equipment instance is NOT deleted — it reverts to unequipped on the equipment surface.
  const surface = await loadEquipmentSurface({ storage: createStorageApi({ root }) });
  assert.ok(surface.instances.some((instance) => instance.instance_id === 'wpn_hom'));
});

test('can_synthesize is false when fewer than 10 materials are held', async (t) => {
  const root = await atelierRoot(t, { inventory: { money: 0, items: [{ item_id: 'material_light_t4', quantity: 9 }] } });
  const view = await buildAtelierArrivalView({ root });
  assert.equal(view.can_synthesize, false, 'holding 9 (<10) materials blocks synthesis');
  assert.equal(view.materials.find((m) => m.item_id === 'material_light_t4').held, 9);
  assert.equal(view.materials.find((m) => m.item_id === 'material_dark_t1').held, 0, 'unheld materials list as held 0');
});
