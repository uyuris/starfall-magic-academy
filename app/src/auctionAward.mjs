// 競売場の落札帰属 writer — the three atomic ownership transactions for a PLAYER win.
//
// Each writer is the "判定→消費" boundary the workshop / atelier use: the money debit (落札額) and the target-
// surface mutation are bound into ONE inventory transaction, so a failure at any stage leaves the player's money
// and the target surface untouched (未消費). An NPC win never reaches these writers — it touches no player asset
// (record-only, the session's concern). The being writer additionally exposes the roster-full predicate the bid
// eligibility check needs, and fails fast (満枠) BEFORE any consume.
//
// This layer calls no LLM: the equipment 銘/来歴 and the being 紹介文/話し方 are inputs, generated upstream and
// passed in. It only writes state.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { consumeInventoryItems } from './economy.mjs';
import { addEquipmentInstance, loadEquipmentSurface, findEquipmentInstance, writeEquipmentSurface } from './equipment.mjs';
import { equippedInstanceIds } from './equipmentSale.mjs';
import { faceExpressions } from './faceExpressions.mjs';
import { publicCanonicalFaceUrl } from './characterCatalog.mjs';
import { requireRoutingContentWeek } from './routingContentResult.mjs';
import {
  HOMUNCULI_SURFACE_PATH,
  HOMUNCULUS_ID_PATTERN,
  MAX_ACTIVE_HOMUNCULI,
  appendActiveHomunculus,
  emptyHomunculiSurface,
  loadHomunculiSurface
} from './homunculusSurface.mjs';
import {
  auctionCatalogItem,
  deriveAuctionEquipmentInstance,
  generateAuctionBeingParameters
} from './routingAuction.mjs';
import { loadStarCradleCreaturesSurface, writeStarCradleCreaturesSurface } from './starCradleSurface.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

// The next monotonic homunculus id across the shared surface (atelier ∪ auction beings ∪ nameplates): max used
// NNN + 1, so a farewelled or an existing id is never reissued.
function nextHomunculusId(surface) {
  let max = 0;
  for (const entry of [...(surface.active ?? []), ...(surface.nameplates ?? [])]) {
    const match = /^homunculus_(\d{3})$/.exec(entry.homunculus_id ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 999) throw new Error('homunculus id space (homunculus_001..homunculus_999) is exhausted');
  return `homunculus_${String(next).padStart(3, '0')}`;
}

// ----- A: weapon / amulet → player_equipment append -----

// Awards a weapon/amulet lot to the player: derives the one-of-a-kind equipment instance (with the LLM-supplied
// 銘/来歴), then debits the winning bid and appends the instance in one transaction. A failure leaves money and
// the surface untouched. Returns the appended instance and the resulting inventory.
export async function awardAuctionEquipmentToPlayer({ root, storage, item, week, price, name, flavor } = {}) {
  const api = storageFor({ root, storage });
  const amount = positiveInteger(price, 'auction winning price');
  const instance = deriveAuctionEquipmentInstance({ item, week, name, flavor });

  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: [],
    moneyCost: amount,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = await loadEquipmentSurface({ storage: api });
      return await addEquipmentInstance({ storage: api, instance });
    },
    rollbackBeforeWrite: async () => {
      await writeEquipmentSurface({ storage: api, surface: priorSurface });
    }
  });

  return { instance, price: amount, inventory: transaction.inventory };
}

// ----- B / D: treasure / flavor → inventory grant -----

// Awards a treasure or flavor lot to the player: debits the winning bid and grants the item to the inventory in
// one transaction (the item is a known auction inventory definition, so the grant passes the economy gate). A
// failure leaves money and inventory untouched. Returns the granted item id and the resulting inventory.
export async function awardAuctionItemToPlayer({ root, storage, catalog, itemId, price } = {}) {
  const api = storageFor({ root, storage });
  const amount = positiveInteger(price, 'auction winning price');
  const item = auctionCatalogItem(catalog, itemId);
  if (item.category !== 'treasure' && item.category !== 'flavor') {
    throw new Error(`auction item grant requires a treasure or flavor item: ${item.category}`);
  }
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: [],
    moneyCost: amount,
    rewards: [{ item_id: item.item_id, quantity: 1 }]
  });
  return { item_id: item.item_id, price: amount, inventory: transaction.inventory };
}

// ----- C: being → 錬成室 slot consume + actor directory seed -----

// Whether an auction being can be adopted: the shared homunculi roster has a free slot (< 3 active). The bid
// eligibility check reads this so a full roster shows 入札不可 rather than failing at award time.
export function canAdoptAuctionBeing(surface) {
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
    throw new Error('homunculi surface is required to judge auction being adoption');
  }
  return (surface.active?.length ?? 0) < MAX_ACTIVE_HOMUNCULI;
}

function beingRosterFullError() {
  const error = new Error(`the atelier already holds the maximum of ${MAX_ACTIVE_HOMUNCULI} homunculi; farewell one before adopting an auction being`);
  error.statusCode = 409;
  error.errorCode = 'AUCTION_BEING_ROSTER_FULL';
  return error;
}

async function seedBeingActorDirectory({ api, homunculusId, profile }) {
  const base = `game_data/homunculi/${homunculusId}`;
  await api.writeJson(`${base}/profile.json`, profile);
  await api.writeJson(`${base}/flags.json`, { character_id: homunculusId, flags: {} });
  await api.writeJson(`${base}/skills.json`, { character_id: homunculusId, skills: [] });
}

async function removeBeingActorDirectory({ api, homunculusId }) {
  const profilePath = api.resolveWritePath(`game_data/homunculi/${homunculusId}/profile.json`);
  await fs.rm(path.dirname(profilePath), { recursive: true, force: true });
}

// Awards a being lot to the player: mints a homunculus_NNN actor on the shared 錬成室 surface, consuming one of
// the three slots. Fails fast (満枠) BEFORE any consume. The being's species (homunculus/spirit/monster), origin
// (競売場で迎えた), element/form seed, and its band-derived parameters are seeded into the actor profile; its
// 紹介文/話し方 are the LLM-supplied inputs (prompt_description / speaking_basis). The money debit, actor-directory
// seed, and surface append are one atomic transaction; a failure leaves money, the surface, and the directory
// untouched. Returns the minted being and the resulting inventory.
export async function awardAuctionBeingToPlayer({ root, storage, catalog, itemId, price, promptDescription, speakingBasis } = {}) {
  const api = storageFor({ root, storage });
  const amount = positiveInteger(price, 'auction winning price');
  const item = auctionCatalogItem(catalog, itemId);
  if (item.category !== 'being') throw new Error(`auction being adoption requires a being item: ${item.category}`);
  const description = requiredString(promptDescription, 'auction being prompt_description');
  const speaking = requiredString(speakingBasis, 'auction being speaking_basis');

  const surface = await loadHomunculiSurface({ storage: api });
  if (!canAdoptAuctionBeing(surface)) throw beingRosterFullError();

  const state = await api.readJson(RUNTIME_STATE_PATH);
  const week = requireRoutingContentWeek(state);
  const homunculusId = nextHomunculusId(surface);
  const parameters = generateAuctionBeingParameters({ band: item.band, itemId: item.item_id });

  const profile = {
    character_id: homunculusId,
    display_name: item.name,
    visual_set_id: item.face_id,
    prompt_description: description,
    speaking_basis: speaking,
    available_expressions: [...faceExpressions],
    parameters,
    // Auction-being provenance kept on the actor profile (surface entry shape unchanged): species, the
    // "競売場で迎えた" origin frame, and the species-specific seed (spirit 系統 / monster 姿).
    species: item.species,
    origin: 'auction',
    ...(item.species === 'spirit' ? { element: item.element } : {}),
    ...(item.species === 'monster' ? { form_seed: item.form_seed } : {}),
    temperament_seed: item.temperament_seed
  };
  const activeEntry = { homunculus_id: homunculusId, display_name: item.name, face_id: item.face_id, created_week: week };

  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: [],
    moneyCost: amount,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = await loadHomunculiSurface({ storage: api });
      await seedBeingActorDirectory({ api, homunculusId, profile });
      return await appendActiveHomunculus({ storage: api, entry: activeEntry });
    },
    rollbackBeforeWrite: async () => {
      await api.writeJson(HOMUNCULI_SURFACE_PATH, priorSurface ?? emptyHomunculiSurface());
      await removeBeingActorDirectory({ api, homunculusId });
    }
  });

  return {
    being: {
      homunculus_id: homunculusId,
      display_name: item.name,
      face_id: item.face_id,
      species: item.species,
      created_week: week,
      parameters,
      face_url: publicCanonicalFaceUrl(item.face_id, 'neutral')
    },
    price: amount,
    inventory: transaction.inventory
  };
}

// ----- D2: caged creature → 星の揺り籠 籠入りへ append (星の揺り籠 connection・落札側) -----

// Awards a caged-creature house lot to the player: debits the winning bid and appends a caged instance to
// star_cradle_creatures.json in ONE transaction. The instance stores the 種卵 item_id + the lot's instance seed
// (the identity source — variety/変貌 are re-derived by C-28, never a second copy) with an empty feed and NO name
// (name:null → the player names it via the star cradle release flow). LM 非経由. A failure leaves money and the
// caged surface untouched (the money debit is the inventory write, the append is the atomic beforeWrite; the money
// check runs before the beforeWrite so an under-funded win never appends). Returns the caged instance + inventory.
export async function awardAuctionCagedCreatureToPlayer({ root, storage, item, week, price } = {}) {
  const api = storageFor({ root, storage });
  const amount = positiveInteger(price, 'auction winning price');
  if (item?.category !== 'caged_creature') throw new Error(`auction caged creature award requires a caged_creature lot item: ${item?.category}`);
  const instance = {
    instance_id: `sc_creature_${positiveInteger(item.seed, 'auction caged creature seed')}`,
    item_id: requiredString(item.item_id, 'auction caged creature item_id'),
    seed: positiveInteger(item.seed, 'auction caged creature seed'),
    feed: {},
    name: null,
    caged_week: nonNegativeInteger(week, 'auction caged creature week')
  };

  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: [],
    moneyCost: amount,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = await loadStarCradleCreaturesSurface({ storage: api });
      return await writeStarCradleCreaturesSurface({ storage: api, surface: { ...priorSurface, instances: [...priorSurface.instances, instance] } });
    },
    rollbackBeforeWrite: async () => {
      await writeStarCradleCreaturesSurface({ storage: api, surface: priorSurface });
    }
  });

  return { caged: instance, price: amount, inventory: transaction.inventory };
}

// ----- E: consignment (player-listed lot) payout — remove the asset, credit the winning bid -----

// The reverse of the award writers. An NPC won the player's consigned asset, so the asset LEAVES the player and the
// winning bid is CREDITED. The asset removal (an equipment instance off the surface, or one inventory item) and the
// money credit are ONE atomic transaction — a failure leaves the asset AND the money untouched. 流札 never reaches
// here (the asset stays with the player). An equipment instance worn by any owner (`equipment_instance_equipped`)
// or an unknown instance (`unknown_equipment_instance`) is rejected before any write, the same guards as a sale.
// Returns { source, amount, inventory }.
export async function payoutConsignmentToPlayer({ root, storage, source, amount } = {}) {
  const api = storageFor({ root, storage });
  const credit = positiveInteger(amount, 'auction consignment payout amount');
  const kind = requiredString(source?.kind, 'auction consignment source.kind');

  if (kind === 'equipment') {
    const instanceId = requiredString(source.instance_id, 'auction consignment source.instance_id');
    const surface = await loadEquipmentSurface({ storage: api });
    const instance = findEquipmentInstance(surface, instanceId);
    if (!instance) throw new Error('unknown_equipment_instance');
    const state = await api.readJson(RUNTIME_STATE_PATH);
    if (equippedInstanceIds(state).has(instanceId)) throw new Error('equipment_instance_equipped');

    let priorSurface = null;
    const transaction = await consumeInventoryItems({
      root: api.paths.projectRoot,
      itemCosts: [],
      moneyCost: 0,
      moneyReward: credit,
      rewards: [],
      beforeWrite: async () => {
        priorSurface = surface;
        const next = { version: 1, instances: surface.instances.filter((candidate) => candidate.instance_id !== instanceId) };
        return await writeEquipmentSurface({ storage: api, surface: next });
      },
      rollbackBeforeWrite: async () => {
        await writeEquipmentSurface({ storage: api, surface: priorSurface });
      }
    });
    return { source: { kind: 'equipment', instance_id: instanceId }, amount: credit, inventory: transaction.inventory };
  }

  if (kind === 'item') {
    const itemId = requiredString(source.item_id, 'auction consignment source.item_id');
    // consumeInventoryItems' itemCosts gate rejects the removal if the item is not held (insufficient_*), so a
    // missing item is a 400-classified throw, never a partial write.
    const transaction = await consumeInventoryItems({
      root: api.paths.projectRoot,
      itemCosts: [{ item_id: itemId, quantity: 1 }],
      moneyCost: 0,
      moneyReward: credit,
      rewards: []
    });
    return { source: { kind: 'item', item_id: itemId }, amount: credit, inventory: transaction.inventory };
  }

  if (kind === 'star_cradle_creature') {
    // The 星の揺り籠 caged instance leaves the player's cage surface in exchange for the winning bid. Removal (off
    // star_cradle_creatures.json) + money credit are one atomic transaction. An unknown instance is rejected before
    // any write (the session re-validates the asset before calling here, so this is a defensive backstop).
    const instanceId = requiredString(source.instance_id, 'auction consignment source.instance_id');
    const surface = await loadStarCradleCreaturesSurface({ storage: api });
    if (!surface.instances.some((candidate) => candidate.instance_id === instanceId)) throw new Error('unknown_star_cradle_creature');

    let priorSurface = null;
    const transaction = await consumeInventoryItems({
      root: api.paths.projectRoot,
      itemCosts: [],
      moneyCost: 0,
      moneyReward: credit,
      rewards: [],
      beforeWrite: async () => {
        priorSurface = surface;
        const next = { ...surface, instances: surface.instances.filter((candidate) => candidate.instance_id !== instanceId) };
        return await writeStarCradleCreaturesSurface({ storage: api, surface: next });
      },
      rollbackBeforeWrite: async () => {
        await writeStarCradleCreaturesSurface({ storage: api, surface: priorSurface });
      }
    });
    return { source: { kind: 'star_cradle_creature', instance_id: instanceId }, amount: credit, inventory: transaction.inventory };
  }

  throw new Error(`auction consignment payout unknown source kind: ${kind}`);
}

// Re-exported so a caller that resolves the actor id shape can reuse the shared homunculus id predicate.
export { HOMUNCULUS_ID_PATTERN };
