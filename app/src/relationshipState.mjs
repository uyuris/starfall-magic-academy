import { createStorageApi } from './storage.mjs';
import { isSelectableCharacterId } from './characterCatalog.mjs';
import { isHomunculusIdFormat, loadActiveHomunculusIdSet } from './companionRoster.mjs';

async function readJson(storage, relativePath) {
  return storage.readJson(relativePath);
}

async function writeJson(storage, relativePath, value) {
  await storage.writeJson(relativePath, value);
}

async function readJsonIfExists(storage, relativePath) {
  return storage.readJsonIfExists(relativePath);
}

function cleanCharacterId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function uniqueCharacterIds(values = []) {
  const ids = [];
  for (const value of values) {
    const id = cleanCharacterId(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The enemy vocabulary is selectable-only (a homunculus can never be an enemy).
function requireSelectableRelationshipId(role, characterId) {
  if (!isSelectableCharacterId(characterId)) {
    const error = new Error(`${role} character is not a selectable roster character: ${characterId}`);
    error.statusCode = 400;
    throw error;
  }
}

// The buddy vocabulary is selectable roster ∪ ACTIVE homunculus. A non-selectable, non-active-homunculus id
// (routing persona / creature / non-active homunculus / garbage) is the caller's 400. The message keeps the
// "buddy character is not a selectable roster character" phrasing as a substring so it stays a superset of
// the prior selectable-only rejection.
function requireBuddyRelationshipId(characterId, activeHomunculusIds) {
  if (isSelectableCharacterId(characterId)) return;
  if (isHomunculusIdFormat(characterId) && activeHomunculusIds.has(characterId)) return;
  const error = new Error(`buddy character is not a selectable roster character or an active homunculus: ${characterId}`);
  error.statusCode = 400;
  throw error;
}

function buddyFlagId(characterId) {
  return `relationship.${characterId}.buddy`;
}

function enemyFlagId(characterId) {
  return `relationship.${characterId}.enemy`;
}

// The runtime-state collection a relationship flag for an id lives under: a homunculus id under `homunculi`,
// every other id (selectable / the recoverable stale `lina`) under `characters`.
function relationshipStateCollection(characterId) {
  return isHomunculusIdFormat(characterId) ? 'homunculi' : 'characters';
}

// Ids in a runtime-state collection whose buddy flag is currently true (a previous buddy to clear).
function collectionBuddyFlagIds(collection) {
  return Object.entries(collection ?? {})
    .filter(([characterId, entry]) => entry?.flags?.[buddyFlagId(characterId)] === true)
    .map(([characterId]) => characterId);
}

function collectionEnemyFlagIds(collection) {
  return Object.entries(collection ?? {})
    .filter(([characterId, entry]) => entry?.flags?.[enemyFlagId(characterId)] === true)
    .map(([characterId]) => characterId);
}

function setRuntimeRelationshipFlag(state, characterId, flagId, value) {
  const collection = relationshipStateCollection(characterId);
  state[collection] ??= {};
  state[collection][characterId] ??= { flags: {} };
  state[collection][characterId].flags ??= {};
  state[collection][characterId].flags[flagId] = value;
}

// Writes one relationship flag onto a selectable character's actor flags file.
async function setCharacterFileFlag(storage, characterId, flagId, value) {
  const relativePath = `game_data/characters/${characterId}/flags.json`;
  const current = await readJsonIfExists(storage, relativePath) ?? { character_id: characterId, flags: {} };
  current.character_id ??= characterId;
  current.flags ??= {};
  current.flags[flagId] = value;
  await writeJson(storage, relativePath, current);
}

// Writes one relationship flag onto a homunculus's actor flags file (a homunculus is only ever a buddy).
async function setHomunculusFileFlag(storage, homunculusId, flagId, value) {
  const relativePath = `game_data/homunculi/${homunculusId}/flags.json`;
  const current = await readJsonIfExists(storage, relativePath) ?? { character_id: homunculusId, flags: {} };
  current.character_id ??= homunculusId;
  current.flags ??= {};
  current.flags[flagId] = value;
  await writeJson(storage, relativePath, current);
}

// The debug relationship setter: replaces the whole buddy/enemy relationship state with the given next buddy
// (a selectable character or an active homunculus) and next enemies (selectable only). The replacement is
// exclusive across BOTH rosters — every previous buddy flag (characters or homunculi) is cleared, so
// switching a buddy between an academy character and a homunculus clears the old side's flag. Enemies stay
// selectable-only. Nothing is silently accepted: a non-active homunculus / non-selectable id fails fast (400)
// before any write.
export async function setRelationshipDebugState({ root, buddyCharacterId = null, enemyCharacterIds = [] }) {
  const storage = createStorageApi({ root });
  const state = await readJson(storage, 'game_data/runtime_state.json');
  const nextBuddyCharacterId = cleanCharacterId(buddyCharacterId);
  const nextEnemyCharacterIds = uniqueCharacterIds(enemyCharacterIds);
  const activeHomunculusIds = await loadActiveHomunculusIdSet({ storage });
  if (nextBuddyCharacterId !== null) requireBuddyRelationshipId(nextBuddyCharacterId, activeHomunculusIds);
  for (const enemyId of nextEnemyCharacterIds) requireSelectableRelationshipId('enemy', enemyId);

  // Previous buddy ids across BOTH rosters, so a cross-roster switch clears the old side's flag. Enemies are
  // selectable-only, so only the characters collection carries an enemy flag.
  const previousBuddyIds = uniqueCharacterIds([
    state.current_buddy_character_id,
    ...collectionBuddyFlagIds(state.characters),
    ...collectionBuddyFlagIds(state.homunculi)
  ]);
  const previousEnemyIds = uniqueCharacterIds([
    ...(Array.isArray(state.current_enemy_character_ids) ? state.current_enemy_character_ids : []),
    ...collectionEnemyFlagIds(state.characters)
  ]);

  const buddyTouchedIds = uniqueCharacterIds([...previousBuddyIds, nextBuddyCharacterId]);
  const enemyTouchedIds = uniqueCharacterIds([...previousEnemyIds, ...nextEnemyCharacterIds]);
  for (const characterId of buddyTouchedIds) {
    setRuntimeRelationshipFlag(state, characterId, buddyFlagId(characterId), characterId === nextBuddyCharacterId);
  }
  for (const characterId of enemyTouchedIds) {
    setRuntimeRelationshipFlag(state, characterId, enemyFlagId(characterId), nextEnemyCharacterIds.includes(characterId));
  }
  state.current_buddy_character_id = nextBuddyCharacterId;
  state.current_enemy_character_ids = nextEnemyCharacterIds;

  await writeJson(storage, 'game_data/runtime_state.json', state);

  // Actor flag files. A homunculus buddy id writes only its buddy flag to the homunculi actor dir; every
  // other touched id keeps the character-file write of both relationship flags, preserving the selectable
  // behavior (and the recoverable stale `lina`).
  const homunculusBuddyIds = buddyTouchedIds.filter((characterId) => isHomunculusIdFormat(characterId));
  const characterTouchedIds = uniqueCharacterIds(
    [...buddyTouchedIds, ...enemyTouchedIds].filter((characterId) => !isHomunculusIdFormat(characterId))
  );
  for (const characterId of characterTouchedIds) {
    await setCharacterFileFlag(storage, characterId, buddyFlagId(characterId), characterId === nextBuddyCharacterId);
    await setCharacterFileFlag(storage, characterId, enemyFlagId(characterId), nextEnemyCharacterIds.includes(characterId));
  }
  for (const homunculusId of homunculusBuddyIds) {
    await setHomunculusFileFlag(storage, homunculusId, buddyFlagId(homunculusId), homunculusId === nextBuddyCharacterId);
  }

  return {
    state,
    relationship: {
      current_buddy_character_id: state.current_buddy_character_id,
      current_enemy_character_ids: state.current_enemy_character_ids
    }
  };
}
