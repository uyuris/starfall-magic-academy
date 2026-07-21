import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  setElapsedWeeksDebug,
  startNextAcademyWeek,
  selectGraduationEndingCharacterId,
  selectGraduationEndingCharacterIds,
  readRoutingGraduationGuide,
  startGraduationEndingConversationForCharacter,
  buildRoutingWeekProgressionKey,
  ROUTING_GRADUATION_GUIDE_STATE_KEY
} from '../src/graduationEnding.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function splitGraduationRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-graduation-split-'));
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    elapsed_weeks: 10,
    ending_started: true,
    ending_completed: true,
    ending_character_id: 'lina',
    current_screen: 'graduation-ending',
    global_flags: {
      'event.graduation_ending.ready': true,
      'event.graduation_ending.completed': true
    },
    event_flag_sources: {
      'event.graduation_ending.ready': { character_id: 'lina', source_type: 'graduation_ending', achieved_at: '2026-01-01T00:00:00.000Z' }
    },
    event_completion_sources: {
      'event.graduation_ending.completed': { character_id: 'lina', source_type: 'graduation_ending', achieved_at: '2026-01-01T00:00:00.000Z' }
    }
  });
  return root;
}

async function splitGraduationSelectionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-graduation-select-'));
  await writeJson(root, 'content/characters/character_001/profile.json', {
    character_id: 'character_001',
    display_name: 'ひとりめ'
  });
  await writeJson(root, 'content/characters/character_002/profile.json', {
    character_id: 'character_002',
    display_name: 'ふたりめ'
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_001/memory/2026-01-01.json', {
    id: 'm1',
    summary: 'older memory'
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_002/memory/2026-01-01.json', {
    id: 'm2',
    summary: 'newer memory 1'
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_002/memory/2026-01-02.json', {
    id: 'm3',
    summary: 'newer memory 2'
  });
  return root;
}

test('graduation ending character selection reads split content/mutable surfaces without consulting legacy game_data/characters', async (t) => {
  const root = await splitGraduationSelectionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const selectedCharacterId = await selectGraduationEndingCharacterId(root);

  assert.equal(selectedCharacterId, 'character_002');
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_001/profile.json')), { code: 'ENOENT' });
});

test('graduationEnding debug/week progression reads and writes split mutable runtime state without creating legacy game_data files', async () => {
  const root = await splitGraduationRoot();

  const debugResult = await setElapsedWeeksDebug({ root, elapsedWeeks: 12 });
  assert.equal(debugResult.state.elapsed_weeks, 12);
  assert.equal(debugResult.state.ending_started, false);
  assert.equal(debugResult.state.global_flags['event.graduation_ending.ready'], false);

  const nextWeekResult = await startNextAcademyWeek({ root, now: '2026-05-18T02:00:00.000Z' });
  assert.equal(nextWeekResult.route, 'academy-training');
  assert.equal(nextWeekResult.state.elapsed_weeks, 13);
  assert.equal(nextWeekResult.state.current_screen, 'academy-training');

  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(savedState.elapsed_weeks, 13);
  assert.equal(savedState.current_screen, 'academy-training');
  assert.equal(savedState.ending_started, false);
  assert.equal(savedState.ending_completed, false);

  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
});

async function guidePlayRoot(t, { candidateMemoryCounts } = {}) {
  const memoryCounts = candidateMemoryCounts ?? { character_001: 1, character_002: 2, character_003: 3 };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-graduation-guide-'));
  const playRoot = path.join(root, 'data/mutable/game_data/play');
  const mutableRoot = path.join(playRoot, 'slots/slot_001/game_data');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const characterId of Object.keys(memoryCounts)) {
    await fs.mkdir(path.join(root, 'content/characters', characterId), { recursive: true });
    await fs.copyFile(
      new URL(`../../content/characters/${characterId}/profile.json`, import.meta.url),
      path.join(root, 'content/characters', characterId, 'profile.json')
    );
    for (let index = 0; index < memoryCounts[characterId]; index += 1) {
      await writeJson(mutableRoot, `characters/${characterId}/memory/2026-01-0${index + 1}.json`, {
        id: `mem_${characterId}_${index}`,
        summary: `memory ${index}`
      });
    }
  }
  await writeJson(mutableRoot, 'runtime_state.json', {
    version: 1,
    elapsed_weeks: 49,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_screen: 'interaction',
    current_interaction_character_id: 'routing_persona',
    last_conversation_id: 'conv_hub_guide_001',
    pending_interaction_context: null,
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {}
  });
  await writeJson(playRoot, '.magic-academy-runtime-paths.json', {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'data/seeds/game_data'),
    mutableRoot,
    characterContentRoot: path.join(root, 'content/characters'),
    canonicalAssetsRoot: path.join(root, 'assets/canonical'),
    publicRoot: path.join(root, 'app/public'),
    resourceRoot: root
  });
  await fs.mkdir(path.join(root, 'data/definitions/game_data'), { recursive: true });
  for (const definition of [
    'event_flags.json',
    'locations.json',
    'alchemy_recipes.json',
    'gathering_points.json',
    'shop_catalog.json',
    'dungeon_materials.json',
    'auction_catalog.json'
  ]) {
    await fs.copyFile(
      new URL(`../../data/definitions/game_data/${definition}`, import.meta.url),
      path.join(root, 'data/definitions/game_data', definition)
    );
  }
  return { resourceRoot: root, playRoot, mutableRoot };
}

function guideRoutingWeekProgression(destinationId = 'alchemy', conversationId = 'conv_hub_guide_001') {
  return {
    idempotency_key: buildRoutingWeekProgressionKey({ conversationId, destinationId }),
    conversation_id: conversationId,
    destination_id: destinationId
  };
}

// Seeds the routing graduation guide state directly on the slot runtime state (the guide is created at hub start,
// not by startNextAcademyWeek), keeping elapsed_weeks at the displayed graduation week (GRADUATION_ENDING_WEEK - 1).
async function seedGuideState(mutableRoot, candidateCharacterIds) {
  const state = await readJson(mutableRoot, 'runtime_state.json');
  await writeJson(mutableRoot, 'runtime_state.json', {
    ...state,
    [ROUTING_GRADUATION_GUIDE_STATE_KEY]: {
      candidate_character_ids: candidateCharacterIds,
      started_at: '2026-05-26T00:00:00.000Z'
    }
  });
}

test('selectGraduationEndingCharacterIds returns the top-N by memory count, sharing the loop selection ordering', async (t) => {
  const root = await splitGraduationSelectionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const topOne = await selectGraduationEndingCharacterIds(root, { limit: 1 });
  assert.deepEqual(topOne, ['character_002']);
  assert.equal((await selectGraduationEndingCharacterId(root)), topOne[0]);

  const topThree = await selectGraduationEndingCharacterIds(root, { limit: 3 });
  assert.deepEqual(topThree, ['character_002', 'character_001']);

  await assert.rejects(() => selectGraduationEndingCharacterIds(root, { limit: 0 }), /positive integer limit/);
});

test('readRoutingGraduationGuide returns null when absent and fail-fasts on a malformed present value', () => {
  assert.equal(readRoutingGraduationGuide({}), null);
  assert.equal(readRoutingGraduationGuide({ routing_graduation_guide: null }), null);
  assert.deepEqual(
    readRoutingGraduationGuide({ routing_graduation_guide: { candidate_character_ids: ['character_003'], started_at: '2026-05-26T00:00:00.000Z' } }),
    { candidate_character_ids: ['character_003'], started_at: '2026-05-26T00:00:00.000Z' }
  );
  assert.throws(() => readRoutingGraduationGuide({ routing_graduation_guide: { candidate_character_ids: [], started_at: 'x' } }), /non-empty array/);
  assert.throws(() => readRoutingGraduationGuide({ routing_graduation_guide: { candidate_character_ids: ['lina'], started_at: 'x' } }), /invalid id/);
  assert.throws(() => readRoutingGraduationGuide({ routing_graduation_guide: { candidate_character_ids: ['character_001'] } }), /started_at is required/);
});

test('startNextAcademyWeek fail-fasts when a routing week progression would advance into graduation', async (t) => {
  const { playRoot, resourceRoot, mutableRoot } = await guidePlayRoot(t);

  // The routing graduation guide is created at hub start, and the ending conversation advances the week — a
  // routing dispatch must never reach the graduation week (that would mean a dispatch ran while the guide should
  // have been active). It fail-fasts before any write, leaving the state (elapsed 49, no guide) untouched.
  await assert.rejects(() => startNextAcademyWeek({
    root: playRoot,
    authoringRoot: resourceRoot,
    now: '2026-05-26T00:00:00.000Z',
    nextScreen: 'academy-alchemy',
    routingWeekProgression: guideRoutingWeekProgression('alchemy')
  }), /must not advance into graduation/);

  const savedState = await readJson(mutableRoot, 'runtime_state.json');
  assert.equal(savedState.elapsed_weeks, 49);
  assert.equal(Object.hasOwn(savedState, ROUTING_GRADUATION_GUIDE_STATE_KEY), false);
  assert.equal(Object.hasOwn(savedState, 'routing_week_progressions'), false);
});

test('startGraduationEndingConversationForCharacter starts the selected character event, advances the week, and clears the guide state', async (t) => {
  const { playRoot, resourceRoot, mutableRoot } = await guidePlayRoot(t);
  await seedGuideState(mutableRoot, ['character_003', 'character_002', 'character_001']);

  const phase2 = await startGraduationEndingConversationForCharacter({
    root: playRoot,
    authoringRoot: resourceRoot,
    characterId: 'character_002',
    screen: 'conversation-day',
    now: '2026-05-26T00:05:00.000Z'
  });

  assert.equal(phase2.route, 'graduation-ending');
  assert.equal(phase2.character_id, 'character_002');
  assert.equal(phase2.state.ending_started, true);
  assert.equal(phase2.state.ending_completed, false);
  assert.equal(phase2.state.ending_character_id, 'character_002');
  assert.equal(phase2.state.elapsed_weeks, 50);
  assert.equal(phase2.state.global_flags['event.graduation_ending.ready'], true);
  assert.equal(phase2.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  // The day landing screen maps to current_screen 'interaction' (the same mapping every daytime event
  // conversation uses); the pending_interaction_context is unchanged by the landing screen.
  assert.equal(phase2.state.current_screen, 'interaction');
  assert.equal(phase2.state[ROUTING_GRADUATION_GUIDE_STATE_KEY], undefined);

  const savedState = await readJson(mutableRoot, 'runtime_state.json');
  assert.equal(savedState.ending_character_id, 'character_002');
  assert.equal(savedState[ROUTING_GRADUATION_GUIDE_STATE_KEY], undefined);

  await assert.rejects(() => startGraduationEndingConversationForCharacter({
    root: playRoot,
    authoringRoot: resourceRoot,
    characterId: 'character_002',
    screen: 'conversation-day',
    now: '2026-05-26T00:06:00.000Z'
  }), /guide is not active/);
});

test('startGraduationEndingConversationForCharacter rejects a character that was not one of the presented candidates', async (t) => {
  const { playRoot, resourceRoot, mutableRoot } = await guidePlayRoot(t);
  await seedGuideState(mutableRoot, ['character_003', 'character_002', 'character_001']);

  await assert.rejects(() => startGraduationEndingConversationForCharacter({
    root: playRoot,
    authoringRoot: resourceRoot,
    characterId: 'character_050',
    screen: 'conversation-day',
    now: '2026-05-26T00:05:00.000Z'
  }), /not a presented candidate/);
});

test('startGraduationEndingConversationForCharacter starts the guide-persona (lina) event without materializing selectable storage', async (t) => {
  const { playRoot, resourceRoot, mutableRoot } = await guidePlayRoot(t);
  await seedGuideState(mutableRoot, ['character_003', 'character_002', 'character_001']);

  const phase2 = await startGraduationEndingConversationForCharacter({
    root: playRoot,
    authoringRoot: resourceRoot,
    // The guide persona (案内人自身) is a permanent option outside the presented top-3 candidates.
    characterId: 'lina',
    screen: 'conversation-day',
    now: '2026-05-26T00:05:00.000Z'
  });

  assert.equal(phase2.route, 'graduation-ending');
  assert.equal(phase2.character_id, 'lina');
  assert.equal(phase2.state.ending_started, true);
  assert.equal(phase2.state.ending_completed, false);
  assert.equal(phase2.state.ending_character_id, 'lina');
  assert.equal(phase2.state.elapsed_weeks, 50);
  assert.equal(phase2.state.global_flags['event.graduation_ending.ready'], true);
  // The event flag source names the persona actor, so completion routes through the persona (lina) actor.
  assert.equal(phase2.state.event_flag_sources['event.graduation_ending.ready'].character_id, 'lina');
  assert.equal(phase2.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(phase2.state[ROUTING_GRADUATION_GUIDE_STATE_KEY], undefined);

  const savedState = await readJson(mutableRoot, 'runtime_state.json');
  assert.equal(savedState.ending_character_id, 'lina');
  assert.equal(savedState[ROUTING_GRADUATION_GUIDE_STATE_KEY], undefined);
  // The guide persona is non-selectable: no per-slot selectable character storage is materialized for lina.
  await assert.rejects(fs.access(path.join(mutableRoot, 'characters/lina')), { code: 'ENOENT' });
});

// Build an active-play root primed at week 49 (so the next week enters the loop graduation ending), with the
// definitions the graduation event-flag setup reads. Returns the roots so each test drives startNextAcademyWeek
// with its own resolved landing screen.
async function graduationLoopEndingRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-graduation-active-play-'));
  const playRoot = path.join(root, 'data/mutable/game_data/play');
  const mutableRoot = path.join(playRoot, 'slots/slot_001/game_data');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(root, 'content/characters/character_001'), { recursive: true });
  await fs.copyFile(
    new URL('../../content/characters/character_001/profile.json', import.meta.url),
    path.join(root, 'content/characters/character_001/profile.json')
  );
  await writeJson(mutableRoot, 'runtime_state.json', {
    version: 1,
    elapsed_weeks: 49,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_screen: 'academy-room',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    pending_interaction_context: null,
    current_interaction_character_id: null
  });
  await writeJson(playRoot, '.magic-academy-runtime-paths.json', {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'data/seeds/game_data'),
    mutableRoot,
    characterContentRoot: path.join(root, 'content/characters'),
    canonicalAssetsRoot: path.join(root, 'assets/canonical'),
    publicRoot: path.join(root, 'app/public'),
    resourceRoot: root
  });
  await fs.mkdir(path.join(root, 'data/definitions/game_data'), { recursive: true });
  for (const name of [
    'alchemy_recipes.json',
    'event_flags.json',
    'gathering_points.json',
    'locations.json',
    'shop_catalog.json',
    'dungeon_materials.json',
    'auction_catalog.json'
  ]) {
    await fs.copyFile(
      new URL(`../../data/definitions/game_data/${name}`, import.meta.url),
      path.join(root, 'data/definitions/game_data', name)
    );
  }
  return { root, playRoot, mutableRoot };
}

test('startNextAcademyWeek enters graduation ending from active play root while initializing selectable storage from explicit authoring root', async (t) => {
  const { root, playRoot, mutableRoot } = await graduationLoopEndingRoot(t);

  const result = await startNextAcademyWeek({
    root: playRoot,
    authoringRoot: root,
    now: '2026-05-26T00:00:00.000Z',
    graduationEndingScreen: 'conversation-day'
  });

  assert.equal(result.route, 'graduation-ending');
  assert.equal(result.character_id, 'character_001');
  assert.equal(result.state.elapsed_weeks, 50);
  assert.equal(result.state.ending_started, true);
  assert.equal(result.state.ending_completed, false);
  assert.equal(result.state.ending_character_id, 'character_001');
  assert.equal(result.state.global_flags['event.graduation_ending.ready'], true);
  assert.equal(result.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  // The loop graduation lands on the resolved academy_conversation_screen: the day screen maps to
  // current_screen 'interaction' (the same mapping every daytime event conversation uses).
  assert.equal(result.state.current_screen, 'interaction');

  const savedState = await readJson(mutableRoot, 'runtime_state.json');
  assert.equal(savedState.ending_character_id, 'character_001');
  assert.equal(savedState.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  await assert.rejects(fs.access(path.join(root, 'data/mutable/characters/character_001/profile.json')), { code: 'ENOENT' });
});

test('startNextAcademyWeek graduation keeps the legacy session current_screen, and fail-fasts without a resolved landing screen', async (t) => {
  const { root, playRoot } = await graduationLoopEndingRoot(t);

  // A missing graduationEndingScreen is a wiring bug — the loop caller must resolve the landing screen. It
  // fail-fasts before any graduation write rather than persisting an ending with an unresolved landing screen.
  await assert.rejects(() => startNextAcademyWeek({
    root: playRoot,
    authoringRoot: root,
    now: '2026-05-26T00:00:00.000Z'
  }), /graduationEndingScreen is required/);

  const legacy = await startNextAcademyWeek({
    root: playRoot,
    authoringRoot: root,
    now: '2026-05-26T00:00:00.000Z',
    graduationEndingScreen: 'academy-conversation-session'
  });
  assert.equal(legacy.route, 'graduation-ending');
  // The 'legacy' preference keeps current_screen at the session screen (byte-equivalent to before the day landing).
  assert.equal(legacy.state.current_screen, 'academy-conversation-session');
});
