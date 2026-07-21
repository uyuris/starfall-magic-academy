import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATELIER_SYNTHESIS_MODES,
  ATELIER_SYNTHESIS_MODE_LABELS,
  ATELIER_TOTAL_WEEKS,
  validateAtelierArrivalPayload,
  validateAtelierSynthesisResult,
  validateAtelierFarewellResult,
  validateAtelierConversationStart,
  validateAtelierParameters,
  atelierParameterRows,
  atelierSelectionTotal,
  atelierSelectionMaterials,
  isAtelierSelectionComplete
} from '../public/atelierArrivalClient.js';

// A well-formed server-normalized parameter shape: 6 magic keys + 5 ability keys, each { min, max, label, value }.
const MAGIC_KEYS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
const ABILITY_KEYS = ['strength', 'agility', 'academics', 'magical_power', 'charisma'];
function parameters(overrides = {}) {
  const magic = Object.fromEntries(MAGIC_KEYS.map((key, index) => [key, { min: 0, max: 100, label: `${key}習熟度`, value: 10 * index }]));
  const abilities = Object.fromEntries(ABILITY_KEYS.map((key, index) => [key, { min: 0, max: 100, label: `${key}能力`, value: 5 * index }]));
  return { magic, abilities, ...overrides };
}

function activeEntry(overrides = {}) {
  return {
    homunculus_id: 'homunculus_001',
    display_name: 'ミラ',
    face_id: 'hp_004',
    visual_set_id: 'hp_004',
    face_url: '/canonical/character_visual_sets/hp_004/face_emotions/neutral.jpg',
    created_week: 3,
    affinity: 50,
    is_buddy: false,
    parameters: parameters(),
    ...overrides
  };
}

function nameplateEntry(overrides = {}) {
  return {
    homunculus_id: 'homunculus_002',
    display_name: 'ノア',
    face_id: 'hp_009',
    visual_set_id: 'hp_009',
    face_url: '/canonical/character_visual_sets/hp_009/face_emotions/neutral.jpg',
    epitaph: '静かな火を灯した子',
    farewell_week: 12,
    ...overrides
  };
}

// The 24-entry material picker data (one per element×tier). A short fixture slice is enough for the shape tests.
function materials(overrides = []) {
  const base = [
    { item_id: 'material_light_t1', name: '光の欠片', element: 'light', tier: 1, held: 4 },
    { item_id: 'material_dark_t2', name: '闇の澱', element: 'dark', tier: 2, held: 0 },
    { item_id: 'material_fire_t4', name: '火竜の鱗', element: 'fire', tier: 4, held: 8 }
  ];
  return overrides.length > 0 ? overrides : base;
}

function arrivalPayload(overrides = {}) {
  return {
    week: 3,
    active: [activeEntry()],
    nameplates: [nameplateEntry()],
    max_active: 3,
    can_synthesize: true,
    materials: materials(),
    required_material_total: 10,
    conversation_spent: false,
    post_content_screen: 'interaction',
    ...overrides
  };
}

test('validateAtelierArrivalPayload normalizes a well-formed arrival envelope', () => {
  const view = validateAtelierArrivalPayload(arrivalPayload());
  assert.equal(view.week, 3);
  assert.equal(view.maxActive, 3);
  assert.equal(view.canSynthesize, true);
  assert.equal(view.conversationSpent, false);
  assert.equal(view.postContentScreen, 'interaction');
  assert.equal(view.active.length, 1);
  assert.deepEqual(
    { name: view.active[0].display_name, week: view.active[0].created_week, affinity: view.active[0].affinity },
    { name: 'ミラ', week: 3, affinity: 50 }
  );
  assert.equal(view.nameplates[0].epitaph, '静かな火を灯した子');
  assert.equal(view.requiredMaterialTotal, 10);
  assert.equal(view.materials.length, 3);
  assert.deepEqual(
    { item_id: view.materials[0].item_id, name: view.materials[0].name, element: view.materials[0].element, tier: view.materials[0].tier, held: view.materials[0].held },
    { item_id: 'material_light_t1', name: '光の欠片', element: 'light', tier: 1, held: 4 }
  );
  // The active child carries its 11 normalized parameters (label + value from the server shape).
  assert.equal(atelierParameterRows(view.active[0].parameters).length, 11);
  assert.equal(view.active[0].parameters.magic.light.label, 'light習熟度');
  // is_buddy is validated + preserved (the current-buddy marker for the slot buddy chip).
  assert.equal(view.active[0].is_buddy, false);
  assert.equal(validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ is_buddy: true })] })).active[0].is_buddy, true);
});

test('validateAtelierArrivalPayload fail-fasts on malformed envelopes', () => {
  assert.throws(() => validateAtelierArrivalPayload(null), /malformed payload/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: 'nope' })), /active must be an array/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ nameplates: null })), /nameplates must be an array/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ week: -1 })), /arrival.week/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ post_content_screen: '' })), /post_content_screen/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ can_synthesize: 'yes' })), /can_synthesize must be a boolean/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ conversation_spent: 1 })), /conversation_spent must be a boolean/);
});

test('validateAtelierArrivalPayload rejects an active count above max_active and malformed entries', () => {
  assert.throws(
    () => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry(), activeEntry(), activeEntry(), activeEntry()], max_active: 3 })),
    /active count 4 exceeds max_active 3/
  );
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ face_url: '' })] })), /face_url/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ affinity: 1.5 })] })), /affinity/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ is_buddy: undefined })] })), /is_buddy must be a boolean/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ is_buddy: 'yes' })] })), /is_buddy must be a boolean/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ active: [activeEntry({ parameters: undefined })] })), /active slot.parameters/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ nameplates: [nameplateEntry({ epitaph: '' })] })), /epitaph/);
});

test('validateAtelierArrivalPayload rejects a malformed material picker + required total', () => {
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ materials: [] })), /materials must be a non-empty array/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ materials: 'nope' })), /materials must be a non-empty array/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ materials: [{ item_id: 'material_light_t1', element: 'light', tier: 1, held: 4 }] })), /material.name/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ materials: [{ item_id: 'material_light_t1', name: '光の欠片', element: 'light', tier: 0, held: 4 }] })), /material.tier/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ materials: [{ item_id: 'material_light_t1', name: '光の欠片', element: 'light', tier: 1, held: -1 }] })), /material.held/);
  assert.throws(() => validateAtelierArrivalPayload(arrivalPayload({ required_material_total: 0 })), /required_material_total/);
});

test('validateAtelierSynthesisResult returns the minted child + mode + parameters + consumed materials and rejects malformed results', () => {
  const consumed = { item_costs: [{ item_id: 'material_fire_t4', quantity: 6, name: '火竜の鱗' }, { item_id: 'material_light_t1', quantity: 4, name: '光の欠片' }] };
  const payload = { result: { homunculus: activeEntry(), mode: 'omakase', consumed_costs: consumed, inventory: {}, content_result: {} }, state: {}, post_content_screen: 'interaction' };
  const result = validateAtelierSynthesisResult(payload);
  assert.equal(result.mode, 'omakase');
  assert.equal(result.homunculus.homunculus_id, 'homunculus_001');
  assert.equal(result.homunculus.created_week, 3);
  // The minted child carries its 11 generated parameters, and the consumed materials carry display names.
  assert.equal(atelierParameterRows(result.homunculus.parameters).length, 11);
  assert.deepEqual(result.consumedMaterials, [
    { item_id: 'material_fire_t4', quantity: 6, name: '火竜の鱗' },
    { item_id: 'material_light_t1', quantity: 4, name: '光の欠片' }
  ]);
  assert.throws(() => validateAtelierSynthesisResult({ result: { homunculus: activeEntry(), mode: 'auto' } }), /result.mode must be one of/);
  assert.throws(() => validateAtelierSynthesisResult({ result: { homunculus: activeEntry(), mode: 'manual' } }), /consumed_costs.item_costs must be a non-empty array/);
  assert.throws(() => validateAtelierSynthesisResult({ result: { homunculus: activeEntry({ parameters: undefined }), mode: 'manual', consumed_costs: consumed } }), /result.homunculus.parameters/);
  assert.throws(() => validateAtelierSynthesisResult({ result: { mode: 'manual' } }), /result.homunculus/);
  assert.throws(() => validateAtelierSynthesisResult({}), /is missing result/);
  assert.ok(ATELIER_SYNTHESIS_MODES.includes(result.mode));
});

test('validateAtelierFarewellResult returns the send-off + 銘 and rejects a missing speech', () => {
  const payload = {
    result: {
      homunculus_id: 'homunculus_001',
      display_name: 'ミラ',
      face_id: 'hp_004',
      face_url: '/canonical/character_visual_sets/hp_004/face_emotions/neutral.jpg',
      farewell_speech: 'ずっと、あなたのそばにいられて幸せでした。',
      epitaph: '静かな火を灯した子',
      farewell_week: 20,
      content_result: {}
    },
    state: {},
    post_content_screen: 'interaction'
  };
  const result = validateAtelierFarewellResult(payload);
  assert.equal(result.display_name, 'ミラ');
  assert.equal(result.farewell_week, 20);
  assert.match(result.farewell_speech, /幸せでした/);
  assert.throws(() => validateAtelierFarewellResult({ result: { ...payload.result, farewell_speech: '' } }), /farewell_speech/);
  assert.throws(() => validateAtelierFarewellResult({ result: { ...payload.result, epitaph: '   ' } }), /epitaph/);
  assert.throws(() => validateAtelierFarewellResult({}), /is missing result/);
});

test('validateAtelierConversationStart returns the pre-started conversation + injected scene + homunculus visual', () => {
  const payload = {
    conversation: {
      id: 'conv_atelier_3_homunculus_001_x',
      location_name: '錬成室',
      visible_situation: '硝子の器が棚に並び、青白い残光が明滅している。',
      messages: [{ role: 'assistant', content: 'おかえりなさい。' }]
    },
    state: { last_conversation_id: 'conv_atelier_3_homunculus_001_x' },
    homunculus: {
      homunculus_id: 'homunculus_001',
      display_name: 'ミラ',
      face_id: 'hp_004',
      visual_set_id: 'hp_004',
      face_url: '/canonical/character_visual_sets/hp_004/face_emotions/neutral.jpg'
    }
  };
  const result = validateAtelierConversationStart(payload);
  assert.equal(result.conversationId, 'conv_atelier_3_homunculus_001_x');
  assert.equal(result.locationName, '錬成室');
  assert.match(result.visibleSituation, /硝子の器/);
  assert.equal(result.homunculus.display_name, 'ミラ');
  assert.throws(() => validateAtelierConversationStart({ ...payload, conversation: { ...payload.conversation, visible_situation: '' } }), /conversation.visible_situation/);
  assert.throws(() => validateAtelierConversationStart({ ...payload, conversation: { ...payload.conversation, location_name: '' } }), /conversation.location_name/);
  assert.throws(() => validateAtelierConversationStart({ ...payload, conversation: undefined }), /is missing the conversation/);
  assert.throws(() => validateAtelierConversationStart({ ...payload, state: undefined }), /is missing state/);
  assert.throws(() => validateAtelierConversationStart({ ...payload, homunculus: { homunculus_id: 'homunculus_001' } }), /homunculus/);
});

test('validateAtelierParameters accepts a well-formed 11-key shape and rejects malformed groups/entries', () => {
  const validated = validateAtelierParameters(parameters());
  assert.equal(Object.keys(validated.magic).length, 6);
  assert.equal(Object.keys(validated.abilities).length, 5);
  assert.deepEqual(validated.magic.light, { label: 'light習熟度', value: 0 });
  assert.throws(() => validateAtelierParameters(null), /parameters must be an object/);
  assert.throws(() => validateAtelierParameters({ abilities: parameters().abilities }), /parameters.magic must be an object/);
  assert.throws(() => validateAtelierParameters({ magic: {}, abilities: parameters().abilities }), /parameters.magic must not be empty/);
  assert.throws(() => validateAtelierParameters(parameters({ magic: { light: { min: 0, max: 100, value: 5 } } })), /parameters.magic.light.label/);
  assert.throws(() => validateAtelierParameters(parameters({ magic: { light: { min: 0, max: 100, label: '光', value: 1.5 } } })), /parameters.magic.light.value/);
});

test('atelierParameterRows flattens the shape into 11 ordered { key, label, value } rows (magic then abilities)', () => {
  const rows = atelierParameterRows(parameters());
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.map((row) => row.key), [...MAGIC_KEYS, ...ABILITY_KEYS]);
  assert.deepEqual(rows[0], { key: 'light', label: 'light習熟度', value: 0 });
  assert.deepEqual(rows[6], { key: 'strength', label: 'strength能力', value: 0 });
  // The label is the server label verbatim (no frontend label map).
  assert.equal(rows[5].label, 'wind習熟度');
});

test('atelierSelectionTotal sums positive integer quantities and ignores stale/non-positive entries', () => {
  assert.equal(atelierSelectionTotal({ a: 3, b: 2 }), 5);
  assert.equal(atelierSelectionTotal({}), 0);
  assert.equal(atelierSelectionTotal(null), 0);
  assert.equal(atelierSelectionTotal({ a: 0, b: -1, c: 1.5, d: 4 }), 4);
});

test('atelierSelectionMaterials flattens the selection map into the synthesize [{item_id, quantity}] shape, dropping zeros', () => {
  assert.deepEqual(
    atelierSelectionMaterials({ material_fire_t4: 6, material_light_t1: 4, material_dark_t2: 0 }),
    [{ item_id: 'material_fire_t4', quantity: 6 }, { item_id: 'material_light_t1', quantity: 4 }]
  );
  assert.deepEqual(atelierSelectionMaterials({}), []);
});

test('isAtelierSelectionComplete requires the exact total AND every quantity within its held count', () => {
  const picker = [
    { item_id: 'material_fire_t4', name: '火竜の鱗', element: 'fire', tier: 4, held: 8 },
    { item_id: 'material_light_t1', name: '光の欠片', element: 'light', tier: 1, held: 4 }
  ];
  assert.equal(isAtelierSelectionComplete({ selection: { material_fire_t4: 6, material_light_t1: 4 }, materials: picker, requiredTotal: 10 }), true);
  // Total short of the target.
  assert.equal(isAtelierSelectionComplete({ selection: { material_fire_t4: 6 }, materials: picker, requiredTotal: 10 }), false);
  // Total over the target.
  assert.equal(isAtelierSelectionComplete({ selection: { material_fire_t4: 8, material_light_t1: 3 }, materials: picker, requiredTotal: 10 }), false);
  // Exact total but one material exceeds its held count.
  assert.equal(isAtelierSelectionComplete({ selection: { material_fire_t4: 5, material_light_t1: 5 }, materials: picker, requiredTotal: 10 }), false);
  // An id that is not in the picker.
  assert.equal(isAtelierSelectionComplete({ selection: { material_fire_t4: 5, unknown_material: 5 }, materials: picker, requiredTotal: 10 }), false);
});

test('the module exports the mode closed set + labels + total weeks', () => {
  assert.deepEqual([...ATELIER_SYNTHESIS_MODES], ['manual', 'omakase']);
  assert.equal(ATELIER_SYNTHESIS_MODE_LABELS.manual, 'マニュアル');
  assert.equal(ATELIER_SYNTHESIS_MODE_LABELS.omakase, 'おまかせ');
  assert.equal(ATELIER_TOTAL_WEEKS, 50);
});
