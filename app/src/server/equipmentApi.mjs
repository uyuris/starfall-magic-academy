import {
  EQUIPMENT_SLOTS,
  PLAYER_EQUIP_TARGET,
  loadEquipmentSurface,
  readEquipmentSlots,
  resolveEquippedInstances,
  buildRunEquipment,
  equipItem,
  unequipItem
} from '../equipment.mjs';
import { equipmentSellPrice, equippedInstanceIds } from '../equipmentSale.mjs';
import { isSelectableCharacterId } from '../characterCatalog.mjs';
import { isHomunculusIdFormat, loadActiveHomunculusIdSet } from '../companionRoster.mjs';
import { resolveActiveHomunculusActor } from '../buddyResolution.mjs';
import { createStorageApi } from '../storage.mjs';

const ROUTES = new Set([
  'GET /api/equipment',
  'POST /api/equipment/equip',
  'POST /api/equipment/unequip'
]);

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const EQUIPMENT_SLOT_SET = new Set(EQUIPMENT_SLOTS);

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

// Requires a JSON object body (readBody returns {} for an empty body). A null,
// array, or primitive body is a malformed request, not a silent "no fields".
function requireBodyObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw statusError('request body must be a JSON object', 400, { errorCode: 'EQUIPMENT_BODY_INVALID' });
  }
  return body;
}

// HTTP-level slot validation against the domain's closed slot set. A missing or
// unknown slot is the caller's 400 with a dedicated code. Validating the caller's
// slot here also disambiguates a later domain `unknown equipment slot` throw as
// corrupt stored state (500) rather than a client error.
function requiredSlot(body) {
  const slot = body.slot;
  if (slot === undefined || slot === null || slot === '') {
    throw statusError('slot is required', 400, { errorCode: 'EQUIPMENT_SLOT_REQUIRED' });
  }
  if (!EQUIPMENT_SLOT_SET.has(slot)) {
    throw statusError(`unknown equipment slot: ${slot}`, 400, { errorCode: 'EQUIPMENT_SLOT_UNKNOWN' });
  }
  return slot;
}

function requiredInstanceId(body) {
  const instanceId = body.instance_id;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw statusError('instance_id is required', 400, { errorCode: 'EQUIPMENT_INSTANCE_ID_REQUIRED' });
  }
  return instanceId;
}

// HTTP-level equip-target validation. The target is an explicit owner — the hero (`'player'`), a selectable
// companion character, or an ACTIVE homunculus companion — with NO implicit default: a missing target is the
// caller's 400, and a non-active homunculus / unknown id is a 400 (never a silent player downgrade). A
// homunculus target is checked against the live homunculi surface here, at the request boundary, before the
// domain equipItem/unequipItem (which accepts the companion id by format). A resolved target is handed to
// the domain, which re-validates its shape.
async function resolveRequiredTarget(body, { root }) {
  const target = body.target;
  if (target === undefined || target === null || target === '') {
    throw statusError('target is required', 400, { errorCode: 'EQUIPMENT_TARGET_REQUIRED' });
  }
  if (target === PLAYER_EQUIP_TARGET || isSelectableCharacterId(target)) return target;
  if (isHomunculusIdFormat(target) && (await loadActiveHomunculusIdSet({ root })).has(target)) return target;
  throw statusError(`unknown equip target: ${target}`, 400, { errorCode: 'EQUIPMENT_TARGET_UNKNOWN' });
}

// Maps an equipItem throw that is about the caller's instance_id (not corrupt
// server state) to a 400 error code. The slot and instance_id are already
// server-validated, so a residual `unknown equipment slot` / non-empty-string throw
// can only come from corrupt stored slots and is left to propagate as a 500.
function equipInstanceClientErrorCode(error) {
  const message = error?.message ?? '';
  if (/^cannot equip unknown instance:/.test(message)) return 'EQUIPMENT_INSTANCE_UNKNOWN';
  if (/^cannot equip .+: already equipped by /.test(message)) return 'EQUIPMENT_INSTANCE_ALREADY_EQUIPPED';
  if (/^equipment slot .+ requires a .+, but .+ is a /.test(message)) return 'EQUIPMENT_KIND_MISMATCH';
  return null;
}

// The equip target of the current run companion (the buddy). `runtime_state.current_buddy_character_id` is the
// one companion who joins a run — a selectable character or an ACTIVE homunculus; absent/null is "no buddy". A
// present value that resolves to neither a selectable character nor an active homunculus is corrupt/dangling
// state and throws — never silently nulled — because the buddy is a real run participant whose equipment must
// be real to be shown.
function resolveBuddyEquipTarget(state, activeHomunculusIds) {
  const buddyId = state?.current_buddy_character_id;
  if (buddyId === null || buddyId === undefined) return null;
  if (isSelectableCharacterId(buddyId)) return buddyId;
  if (isHomunculusIdFormat(buddyId) && activeHomunculusIds.has(buddyId)) return buddyId;
  throw new Error(`runtime_state.current_buddy_character_id is present but does not resolve to a selectable character or an active homunculus: ${JSON.stringify(buddyId)}`);
}

// The buddy sub-view mirrors the player fields by the SAME derivation: the buddy's two slots resolved to their
// instances plus the buddy run-equipment summary (unequipped -> null). `null` when no buddy is set. A homunculus
// buddy additionally carries its server-resolved display_name + face_url, because the frontend cannot resolve a
// homunculus from the selectable roster the way it does a selectable buddy.
async function buildBuddyEquipment({ root, state, surface, activeHomunculusIds }) {
  const buddyId = resolveBuddyEquipTarget(state, activeHomunculusIds);
  if (buddyId === null) return null;
  const slots = readEquipmentSlots(state, buddyId);
  const base = {
    character_id: buddyId,
    slots: resolveEquippedInstances({ slots, surface }),
    run_equipment: buildRunEquipment({ slots, surface })
  };
  if (!isHomunculusIdFormat(buddyId)) return base;
  const actor = await resolveActiveHomunculusActor({ root, homunculusId: buddyId });
  return { ...base, display_name: actor.display_name, face_url: actor.face_url };
}

// The purchase screen's per-instance sale view, parallel to `instances` (same order): the
// deterministic sell price and whether the instance is currently worn by any owner (the
// hero or a companion). `equipped` is the exact condition sellEquipmentInstance rejects a
// sale on, so the UI's sellable判定 matches the backend's. `instances` itself stays the
// untouched domain shape; the sale-only fields live here.
function buildInstanceSales({ instances, state }) {
  const equipped = equippedInstanceIds(state);
  return instances.map((instance) => ({
    instance_id: instance.instance_id,
    sell_price: equipmentSellPrice(instance),
    equipped: equipped.has(instance.instance_id)
  }));
}

// The one authoritative snapshot every endpoint returns: the resolved current slots
// (unequipped -> null), every owned instance, the aggregated run-equipment effects
// (unequipped -> null), the current buddy's mirror sub-view (`buddy`: null when unset, else
// { character_id, slots, run_equipment }, plus display_name + face_url for a homunculus buddy), and the per-instance sale view
// (`sales`). All resolution and aggregation is delegated to the equipment domain; nothing is
// re-derived here. Instances are returned in the exact domain shape (validateEquipmentInstance),
// never trimmed or renamed.
async function buildEquipmentSnapshot({ root }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const surface = await loadEquipmentSurface({ storage });
  const activeHomunculusIds = await loadActiveHomunculusIdSet({ storage });
  const slots = readEquipmentSlots(state, PLAYER_EQUIP_TARGET);
  return {
    slots: resolveEquippedInstances({ slots, surface }),
    instances: surface.instances,
    run_equipment: buildRunEquipment({ slots, surface }),
    buddy: await buildBuddyEquipment({ root, state, surface, activeHomunculusIds }),
    sales: buildInstanceSales({ instances: surface.instances, state })
  };
}

export function canHandleEquipmentRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

export async function handleEquipmentApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleEquipmentRoute(req.method, url.pathname)) return false;
  const root = context.activeRoot ?? context.root;

  if (req.method === 'GET' && url.pathname === '/api/equipment') {
    return sendJson(res, await buildEquipmentSnapshot({ root }));
  }

  if (req.method === 'POST' && url.pathname === '/api/equipment/equip') {
    const body = requireBodyObject(await readBody(req));
    const target = await resolveRequiredTarget(body, { root });
    const slot = requiredSlot(body);
    const instanceId = requiredInstanceId(body);
    try {
      await equipItem({ root, target, slot, instance_id: instanceId });
    } catch (error) {
      const errorCode = equipInstanceClientErrorCode(error);
      if (errorCode) return sendJson(res, { error: error.message, error_code: errorCode }, 400);
      throw error;
    }
    return sendJson(res, await buildEquipmentSnapshot({ root }));
  }

  if (req.method === 'POST' && url.pathname === '/api/equipment/unequip') {
    const body = requireBodyObject(await readBody(req));
    const target = await resolveRequiredTarget(body, { root });
    const slot = requiredSlot(body);
    await unequipItem({ root, target, slot });
    return sendJson(res, await buildEquipmentSnapshot({ root }));
  }

  return sendJson(res, { error: 'not found' }, 404);
}
