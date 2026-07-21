import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureSelectableCharacterStorage, isSelectableCharacterId } from '../src/characterCatalog.mjs';
import { initializeNewPlayArea as initializeNewPlayAreaCore, listOpeningMentorCharacterIds } from '../src/playSession.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { ensureElectronRuntimeWorkspace } from '../src/electron/runtimeWorkspace.mjs';
import { baselineRuntimeState, fixtureRoot, readJson, writeJson } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { ROUTING_OPENING_EVENT_FLAG_ID } from '../src/routingOpeningEvent.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../src/routingPersona.mjs';

function initializeNewPlayArea(options) {
  return initializeNewPlayAreaCore({ playMode: 'loop', ...options });
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitPlaySessionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-play-session-split-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    ...baselineRuntimeState,
    disabled_stage_flag_judgment_flows: {
      'stage.herbology_garden.herbology_garden_blue_glass_token': true
    }
  });
  await writeSplitJson(root, 'content/characters/character_001/profile.json', packagedSelectableCharacterProfile('character_001'));
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ',
    identity: '薬草園の案内役',
    visual_set_id: 'visual_set_001',
    prompt_description: 'split root mentor',
    speaking_basis: 'split root speaking',
    available_expressions: ['neutral'],
    parameters: {
      magic: {
        light: { min: 0, max: 100, label: '光魔法習熟度', value: 50 },
        dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 40 },
        fire: { min: 0, max: 100, label: '火魔法習熟度', value: 30 },
        water: { min: 0, max: 100, label: '水魔法習熟度', value: 20 },
        earth: { min: 0, max: 100, label: '土魔法習熟度', value: 10 },
        wind: { min: 0, max: 100, label: '風魔法習熟度', value: 60 }
      },
      abilities: {
        strength: { min: 0, max: 100, label: '筋力', value: 50 },
        agility: { min: 0, max: 100, label: '瞬発力', value: 45 },
        academics: { min: 0, max: 100, label: '学力', value: 65 },
        magical_power: { min: 0, max: 100, label: '魔力', value: 55 },
        charisma: { min: 0, max: 100, label: 'カリスマ', value: 35 }
      }
    }
  });
  return root;
}

function packagedSelectableCharacterProfile(characterId = 'character_001') {
  return {
    character_id: characterId,
    display_name: 'テスト生徒',
    identity: '静かな図書委員',
    parameter_attitude_type: 'equal_any_respect_average',
    prompt_description: '図書室で静かに案内する。',
    speaking_basis: '丁寧で落ち着いた口調。',
    available_expressions: ['neutral'],
    parameters: {
      magic: {
        light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 },
        dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 20 },
        fire: { min: 0, max: 100, label: '火魔法習熟度', value: 18 },
        water: { min: 0, max: 100, label: '水魔法習熟度', value: 22 },
        earth: { min: 0, max: 100, label: '土魔法習熟度', value: 19 },
        wind: { min: 0, max: 100, label: '風魔法習熟度', value: 21 }
      },
      abilities: {
        strength: { min: 0, max: 100, label: '筋力', value: 24 },
        agility: { min: 0, max: 100, label: '瞬発力', value: 26 },
        academics: { min: 0, max: 100, label: '学力', value: 61 },
        magical_power: { min: 0, max: 100, label: '魔力', value: 35 },
        charisma: { min: 0, max: 100, label: 'カリスマ', value: 29 }
      }
    }
  };
}

async function withMockedRandom(value, callback) {
  const originalRandom = Math.random;
  Math.random = () => value;
  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

test('initializeNewPlayArea uses Sera as the opening mentor when there are no valid save slots', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialized = await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');
  const source = playRuntimeState.event_flag_sources['event.opening_mentor_intro.ready'];

  assert.equal(playRuntimeState.global_flags['event.opening_mentor_intro.ready'], true);
  assert.equal(source.character_id, 'character_001');
  assert.equal(source.source_type, 'new_game');
  assert.equal(source.conversation_id, null);
});

test('initializeNewPlayArea seeds only the routing opening event (not the mentor intro) for a routing new game', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialized = await initializeNewPlayAreaCore({
    root,
    slotId: 'slot_001',
    playMode: 'routing',
    routingPersonaVariant: 'fallen_star'
  });
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');

  assert.equal(playRuntimeState.global_flags[ROUTING_OPENING_EVENT_FLAG_ID], true);
  const source = playRuntimeState.event_flag_sources[ROUTING_OPENING_EVENT_FLAG_ID];
  assert.equal(source.character_id, ROUTING_PERSONA_CHARACTER_ID);
  assert.equal(source.source_type, 'new_game');
  assert.equal(source.conversation_id, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(playRuntimeState.global_flags, 'event.opening_mentor_intro.ready'),
    false,
    'routing does not seed the loop mentor intro, which can never fire without the academy-map scan'
  );
});

test('initializeNewPlayArea keeps loop new games free of the routing opening event', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialized = await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');

  assert.equal(playRuntimeState.global_flags['event.opening_mentor_intro.ready'], true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(playRuntimeState.global_flags, ROUTING_OPENING_EVENT_FLAG_ID),
    false,
    'loop keeps its byte-equivalent mentor-only seeding'
  );
});

test('initializeNewPlayArea seeds the empty mp_reserve surface in both loop and routing new games', async (t) => {
  const loopRoot = await splitPlaySessionRoot();
  const routingRoot = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(loopRoot, { recursive: true, force: true });
    await fs.rm(routingRoot, { recursive: true, force: true });
  });

  const loop = await withMockedRandom(0.99, () => initializeNewPlayArea({ root: loopRoot, slotId: 'slot_001' }));
  const routing = await initializeNewPlayAreaCore({ root: routingRoot, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });

  // Dungeon companions exist in both modes, so unlike the routing-only library/homunculi surfaces this
  // seeds identically in loop and routing.
  for (const initialized of [loop, routing]) {
    assert.deepEqual(await readJson(initialized.root, 'game_data/mp_reserve.json'), { version: 1, reserves: {} });
  }
});

test('initializeNewPlayArea keeps random opening mentor selection when a valid save slot already exists', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));
  const initialized = await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_002' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');
  const source = playRuntimeState.event_flag_sources['event.opening_mentor_intro.ready'];

  assert.equal(source.character_id, 'lina');
  assert.equal(source.source_type, 'new_game');
  assert.equal(source.conversation_id, null);
});

test('initializeNewPlayArea keeps random opening mentor selection when overwriting the only existing valid slot', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));

  const initialized = await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');
  const source = playRuntimeState.event_flag_sources['event.opening_mentor_intro.ready'];

  assert.equal(source.character_id, 'lina');
  assert.equal(source.source_type, 'new_game');
  assert.equal(source.conversation_id, null);
});

test('initializeNewPlayArea fails explicitly when first-play Sera profile is missing', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.rm(path.join(root, 'content/characters/character_001'), { recursive: true, force: true });

  await assert.rejects(
    () => withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' })),
    {
      code: 'FIRST_PLAY_OPENING_MENTOR_MISSING',
      errorCode: 'first_play_opening_mentor_missing',
      statusCode: 500
    }
  );
});

test('initializeNewPlayArea treats orphan slot directories as no save data for opening mentor selection', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots/slot_001/game_data'), { recursive: true });

  const initialized = await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_002' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');
  const source = playRuntimeState.event_flag_sources['event.opening_mentor_intro.ready'];

  assert.equal(source.character_id, 'character_001');
});

test('listOpeningMentorCharacterIds excludes beyond-count profile directories from the opening mentor pool', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  // A Phase A profile landed on disk ahead of the catalog character count.
  await writeSplitJson(root, 'content/characters/character_999/profile.json', packagedSelectableCharacterProfile('character_999'));

  const pool = await listOpeningMentorCharacterIds(root);

  assert.ok(pool.includes('character_001'), 'an in-range catalog character stays in the mentor pool');
  assert.ok(pool.includes('lina'), 'the non-numbered default mentor stays in the mentor pool');
  assert.ok(!pool.includes('character_999'), 'a beyond-count profile directory must not enter the mentor pool');
  for (const id of pool) {
    if (/^character_\d{3}$/.test(id)) {
      assert.ok(isSelectableCharacterId(id), `numbered mentor candidate ${id} must be catalog-selectable`);
    }
  }
});

test('initializeNewPlayArea never selects a beyond-count profile as the random opening mentor', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeSplitJson(root, 'content/characters/character_999/profile.json', packagedSelectableCharacterProfile('character_999'));

  // First new game establishes existing save data so the second run uses the random pool.
  await withMockedRandom(0.99, () => initializeNewPlayArea({ root, slotId: 'slot_001' }));
  // 0.5 lands in the middle of the pre-fix pool [character_001, character_999, lina] = character_999,
  // which would 500 on catalog rejection. After the fix the pool is [character_001, lina] and 0.5 -> lina.
  const initialized = await withMockedRandom(0.5, () => initializeNewPlayArea({ root, slotId: 'slot_002' }));
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');
  const source = playRuntimeState.event_flag_sources['event.opening_mentor_intro.ready'];

  assert.notEqual(source.character_id, 'character_999', 'a beyond-count profile must never be chosen as opening mentor');
  assert.equal(source.character_id, 'lina');
});

test('initializeNewPlayArea copies parent stage-flag judgment-flow disabled state into the new play runtime state', async () => {
  const parentDisabledFlows = {
    'stage.herbology_garden.herbology_garden_blue_glass_token': true,
    'stage.forbidden_archive.locked_index_fingerprint': true
  };
  const root = await fixtureRoot('magic-adv-play-session-', {
    runtimeState: {
      ...baselineRuntimeState,
      disabled_stage_flag_judgment_flows: parentDisabledFlows
    }
  });

  const initialized = await initializeNewPlayArea({ root });
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');

  assert.deepEqual(playRuntimeState.disabled_stage_flag_judgment_flows, parentDisabledFlows);

  const parentRuntimeState = await readJson(root, 'game_data/runtime_state.json');
  assert.deepEqual(parentRuntimeState.disabled_stage_flag_judgment_flows, parentDisabledFlows);

  parentDisabledFlows['stage.herbology_garden.herbology_garden_blue_glass_token'] = false;
  const playRuntimeStateAfterLocalMutation = await readJson(initialized.root, 'game_data/runtime_state.json');
  assert.equal(playRuntimeStateAfterLocalMutation.disabled_stage_flag_judgment_flows['stage.herbology_garden.herbology_garden_blue_glass_token'], true);
});

test('initializeNewPlayArea seeds graduation ending progress fields at a safe baseline', async () => {
  const root = await fixtureRoot('magic-adv-play-session-ending-');

  const initialized = await initializeNewPlayArea({ root });
  const playRuntimeState = await readJson(initialized.root, 'game_data/runtime_state.json');

  assert.equal(playRuntimeState.elapsed_weeks, 0);
  assert.equal(playRuntimeState.ending_started, false);
  assert.equal(playRuntimeState.ending_completed, false);
  assert.equal(playRuntimeState.ending_character_id, null);
});

test('initializeNewPlayArea reads split mutable runtime state and creates the play area under data/mutable without creating legacy game_data/play', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sourceProfilePath = path.join(root, 'content/characters/lina/profile.json');
  const before = await fs.stat(sourceProfilePath);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001' });

  assert.equal(initialized.root, path.join(root, 'data/mutable/game_data/play/slots/slot_001'));
  const playRuntimeState = await readJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/runtime_state.json');
  assert.deepEqual(playRuntimeState.disabled_stage_flag_judgment_flows, {
    'stage.herbology_garden.herbology_garden_blue_glass_token': true
  });
  assert.equal(playRuntimeState.global_flags['event.opening_mentor_intro.ready'], true);

  const activeSlot = await readJson(root, 'data/mutable/game_data/play/active_slot.json');
  assert.equal(activeSlot.slot_id, 'slot_001');

  const slotStorage = createStorageApi({ root: initialized.root });
  const slotProfilePath = await slotStorage.resolveReadPath('game_data/characters/lina/profile.json');
  assert.equal(slotProfilePath, sourceProfilePath);

  const after = await fs.stat(sourceProfilePath);
  assert.equal(after.mtimeMs, before.mtimeMs, 'new-game initialization should not rewrite canonical character profiles');

  await assert.rejects(fs.access(path.join(root, 'game_data/play/active_slot.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('initializeNewPlayArea succeeds when symlink creation is not permitted and still resolves canonical reads through storage', async (t) => {
  const root = await splitPlaySessionRoot();
  const originalSymlink = fs.symlink;
  fs.symlink = async () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  t.after(async () => {
    fs.symlink = originalSymlink;
    await fs.rm(root, { recursive: true, force: true });
  });

  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001' });
  const storage = createStorageApi({ root: initialized.root });

  assert.equal(initialized.root, path.join(root, 'data/mutable/game_data/play/slots/slot_001'));
  assert.equal(await storage.resolveReadPath('game_data/locations.json'), path.join(root, 'data/definitions/game_data/locations.json'));
  assert.equal(await storage.resolveReadPath('game_data/characters/lina/profile.json'), path.join(root, 'content/characters/lina/profile.json'));
  const runtimeState = await storage.readJson('game_data/runtime_state.json');
  assert.equal(runtimeState.global_flags['event.opening_mentor_intro.ready'], true);
});

test('initializeNewPlayArea resolves packaged play-root canonical reads through the runtime manifest instead of slot symlinks', async (t) => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-play-session-packaged-resources-'));
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-play-session-packaged-userdata-'));
  t.after(async () => {
    await fs.rm(resourceRoot, { recursive: true, force: true });
    await fs.rm(userDataRoot, { recursive: true, force: true });
  });

  await writeSplitJson(resourceRoot, 'data/definitions/game_data/world/settings.json', {
    academy_name: '霧鐘魔法学院',
    world_description: 'packaged split root fixture'
  });
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/event_flags.json', {});
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/stage_flags.json', {});
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(resourceRoot, 'data/definitions/game_data/locations.json', { locations: [] });
  await writeSplitJson(resourceRoot, 'content/characters/character_001/profile.json', packagedSelectableCharacterProfile('character_001'));

  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot });
  const initialized = await initializeNewPlayArea({ root: workspace.projectRoot, slotId: 'slot_001' });
  const storage = createStorageApi({ root: initialized.root });

  const locationsPath = await storage.resolveReadPath('game_data/locations.json');
  assert.equal(locationsPath, path.join(resourceRoot, 'data/definitions/game_data/locations.json'));

  const profilePath = await storage.resolveReadPath('game_data/characters/character_001/profile.json');
  assert.equal(profilePath, path.join(resourceRoot, 'content/characters/character_001/profile.json'));

  const runtimeStatePath = await storage.resolveReadPath('game_data/runtime_state.json');
  assert.equal(runtimeStatePath, path.join(initialized.root, 'game_data/runtime_state.json'));
});

test('selectable character bootstrap preserves an existing active-play manifest instead of retargeting it to play/game_data', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await initializeNewPlayArea({ root, slotId: 'slot_001' });
  await writeSplitJson(root, 'content/characters/character_007/profile.json', packagedSelectableCharacterProfile('character_007'));
  const playRoot = path.join(root, 'data/mutable/game_data/play');

  await ensureSelectableCharacterStorage({ root: playRoot, authoringRoot: root, characterId: 'character_007' });

  const storage = createStorageApi({ root: playRoot });
  assert.equal(
    await storage.resolveReadPath('game_data/runtime_state.json'),
    path.join(root, 'data/mutable/game_data/play/slots/slot_001/game_data/runtime_state.json')
  );
  assert.equal(
    await storage.resolveReadPath('game_data/characters/character_007/profile.json'),
    path.join(root, 'content/characters/character_007/profile.json')
  );
});

test('initializeNewPlayArea ignores orphan slot directories when auto-generating the first visible slot id', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots/slot_001/game_data'), { recursive: true });

  const initialized = await initializeNewPlayArea({ root });

  assert.equal(initialized.slot.slot_id, 'slot_001');
  const activeSlot = await readJson(root, 'data/mutable/game_data/play/active_slot.json');
  assert.equal(activeSlot.slot_id, 'slot_001');
});

test('initializeNewPlayArea generates the next slot id from valid slots only when orphan directories exist', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (let n = 1; n <= 10; n += 1) {
    await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots', `slot_${String(n).padStart(3, '0')}`), { recursive: true });
  }
  await initializeNewPlayArea({ root, slotId: 'slot_011' });
  await initializeNewPlayArea({ root, slotId: 'slot_012' });

  const initialized = await initializeNewPlayArea({ root });

  assert.equal(initialized.slot.slot_id, 'slot_013');
});

test('initializeNewPlayArea ignores malformed-meta and invalid-name slot directories when auto-generating ids', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots/not-a-slot/game_data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/mutable/game_data/play/slots/not-a-slot/meta.json'), '{broken-json\n', 'utf8');
  await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots/slot_001/game_data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/mutable/game_data/play/slots/slot_001/meta.json'), '{broken-json\n', 'utf8');

  const initialized = await initializeNewPlayArea({ root });

  assert.equal(initialized.slot.slot_id, 'slot_001');
});
