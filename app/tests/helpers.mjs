import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  characterContentRoot,
  definitionsRoot,
  seedsRoot,
  testsFixtureRoot
} from './testPaths.mjs';

const eventFlagsFixturePath = path.join(testsFixtureRoot, 'event_flags.fixture.json');
const linaProfilePath = path.join(characterContentRoot, 'lina/profile.json');

export const baselineRuntimeState = {
  version: 1,
  current_location_id: 'herbology_garden',
  time_slot: 'after_school',
  current_screen: 'field',
  current_interaction_character_id: null,
  global_flags: {
    'knowledge.player.archive_rumor': true,
    'story.archive_intro_done': false,
    'route.archive_note_checked': false
  },
  visited_locations: ['herbology_garden'],
  active_character_ids: ['lina'],
  last_conversation_id: null,
  current_buddy_character_id: null,
  current_enemy_character_ids: [],
  characters: {
    lina: {
      flags: {
        'knowledge.lina.player_checked_garden_label': true,
        'relationship.lina.trust': 0,
        'condition.minor.lina_worried': false
      }
    }
  },
  pending_interaction_context: null
};

async function seedLegacyGameDataDefinitions(root) {
  const definitionFiles = [
    'alchemy_recipes.json',
    'auction_catalog.json',
    'creature_encounters.json',
    'dungeon_materials.json',
    'event_flags.json',
    'gathering_points.json',
    'locations.json',
    'lounge_scenes.json',
    'shop_catalog.json',
    'star_cradle_catalog.json',
    'stage_flags.json',
    'study_circles.json',
    'study_circle_types.json',
    'world/settings.json',
    'prompt/character_speech_constraints.json'
  ];
  for (const relativePath of definitionFiles) {
    const source = path.join(definitionsRoot, relativePath);
    const destination = path.join(root, 'game_data', relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function seedLegacyGameDataSeeds(root) {
  const seedFiles = [
    'runtime_state.json'
  ];
  for (const relativePath of seedFiles) {
    const source = path.join(seedsRoot, relativePath);
    const destination = path.join(root, 'game_data', relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function seedLegacyCharacterAuthoring(root) {
  await fs.cp(characterContentRoot, path.join(root, 'game_data/characters'), { recursive: true });
  const profile = JSON.parse(await fs.readFile(linaProfilePath, 'utf8'));
  await writeJson(root, 'game_data/characters/lina/profile.json', profile);
  await writeJson(root, 'game_data/characters/lina/skills.json', { character_id: 'lina', skills: [] });
  await writeJson(root, 'game_data/characters/lina/flags.json', {
    character_id: 'lina',
    flags: {
      'knowledge.lina.player_checked_garden_label': false,
      'relationship.lina.trust': 0,
      'condition.minor.lina_worried': false
    }
  });
  await fs.mkdir(path.join(root, 'game_data/characters/lina/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'game_data/characters/lina/work_records'), { recursive: true });
}

async function resetLegacyMutableSurfaces(root) {
  await fs.rm(path.join(root, 'game_data/save_slots'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'game_data/logs'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'game_data/play'), { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'game_data/runtime'), { recursive: true });
}

export async function cloneGameDataFixture(root) {
  await seedLegacyGameDataDefinitions(root);
  await seedLegacyGameDataSeeds(root);
  await seedLegacyCharacterAuthoring(root);
  await resetLegacyMutableSurfaces(root);

  const fixtureEventFlags = JSON.parse(await fs.readFile(eventFlagsFixturePath, 'utf8'));
  await writeJson(root, 'game_data/event_flags.json', fixtureEventFlags);
}

export async function fixtureRoot(prefix, { runtimeState = baselineRuntimeState } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await cloneGameDataFixture(root);
  await writeJson(root, 'game_data/runtime_state.json', runtimeState);
  return root;
}

export async function isolatedPlayModeSettingsPath(t, prefix = 'magic-adv-play-mode-settings-') {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  return path.join(settingsRoot, 'play-mode.json');
}

export async function isolatedServerOptions(t, options, prefix) {
  if (Object.hasOwn(options, 'playModeSettingsPath')) return options;
  return {
    ...options,
    playModeSettingsPath: await isolatedPlayModeSettingsPath(t, prefix)
  };
}

export async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

export async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function characterFixtureRoot() {
  return fixtureRoot('magic-adv-character-fixture-');
}
