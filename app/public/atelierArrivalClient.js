// Pure, headless-testable contract validators for the 錬成室 (homunculus atelier) HTTP surface, shared by app.js
// and unit tests so the fail-fast paths — a malformed GET /api/atelier arrival, a POST /api/atelier/synthesize
// result, a POST /api/atelier/farewell result, and a POST /api/atelier/conversation/start opening — are verified
// without a browser. The backend (app/src/server/atelierApi.mjs + app/src/homunculusAtelier.mjs) is the source of
// truth for these shapes; the frontend still refuses a malformed envelope BEFORE any DOM mutation so a broken
// response can never render a faceless slot, a nameless nameplate, or a bodyless birth (no silent fallback).

// The atelier's two synthesis modes, mirroring the backend closed set (app/src/homunculusAtelier.mjs
// HOMUNCULUS_SYNTHESIS_MODES). manual takes the player's persona 骨子; omakase generates the 骨子 from the name
// only. The ids are the exact values POST /api/atelier/synthesize accepts; the labels are the form presentation.
export const ATELIER_SYNTHESIS_MODES = Object.freeze(['manual', 'omakase']);
export const ATELIER_SYNTHESIS_MODE_LABELS = Object.freeze({ manual: 'マニュアル', omakase: 'おまかせ' });

// The 錬成室 spans the same 50-week run as every other content screen's week header.
export const ATELIER_TOTAL_WEEKS = 50;

function atelierString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`atelier: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function atelierInteger(value, label, { min = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (min !== null && value < min)) {
    throw new Error(`atelier: ${label} must be an integer${min !== null ? ` >= ${min}` : ''} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function atelierBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`atelier: ${label} must be a boolean (got ${JSON.stringify(value)})`);
  return value;
}

// One normalized parameter group ({ light: { min, max, label, value }, ... } for magic / abilities). The label is the
// server-authoritative 日本語 display name (parameters.mjs) — the frontend renders it verbatim and never re-keys it to a
// second label map. A malformed entry (missing label / non-integer value) fails fast before the parameter panel renders.
function validateAtelierParameterGroup(group, label) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`atelier: ${label} must be an object (got ${JSON.stringify(group)})`);
  }
  const entries = Object.entries(group);
  if (entries.length === 0) throw new Error(`atelier: ${label} must not be empty (got ${JSON.stringify(group)})`);
  const validated = {};
  for (const [key, stat] of entries) {
    if (!stat || typeof stat !== 'object' || Array.isArray(stat)) {
      throw new Error(`atelier: ${label}.${key} must be an object (got ${JSON.stringify(stat)})`);
    }
    validated[key] = {
      label: atelierString(stat.label, `${label}.${key}.label`),
      value: atelierInteger(stat.value, `${label}.${key}.value`, { min: 0 })
    };
  }
  return validated;
}

// The normalized parameter shape a synthesized child carries ({ magic: {6 keys}, abilities: {5 keys} }, each entry
// { min, max, label, value }). Shared by the active slot, the synthesis result view — every surface that shows a
// child's 11 parameters. Returns only { label, value } per key (the rendered fields); insertion order is preserved.
export function validateAtelierParameters(parameters, label = 'parameters') {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`atelier: ${label} must be an object (got ${JSON.stringify(parameters)})`);
  }
  return {
    magic: validateAtelierParameterGroup(parameters.magic, `${label}.magic`),
    abilities: validateAtelierParameterGroup(parameters.abilities, `${label}.abilities`)
  };
}

// Flatten a validated parameter shape into the ordered rows the parameter panels render: the 6 magic keys followed by
// the 5 ability keys, each { key, label, value }. The label is the server label (no frontend label map); the order is
// the server's insertion order (magic light→wind, abilities strength→charisma).
export function atelierParameterRows(parameters, label = 'parameters') {
  const validated = validateAtelierParameters(parameters, label);
  return [...Object.entries(validated.magic), ...Object.entries(validated.abilities)]
    .map(([key, stat]) => ({ key, label: stat.label, value: stat.value }));
}

// One synthesized/active child's visual + identity fields, shared by the active slot, the synthesis result, the
// farewell result, and the conversation-start payload (the server resolves face_url from the closed face pool).
function validateAtelierHomunculusVisual(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`atelier: ${label} must be an object (got ${JSON.stringify(entry)})`);
  }
  return {
    homunculus_id: atelierString(entry.homunculus_id, `${label}.homunculus_id`),
    display_name: atelierString(entry.display_name, `${label}.display_name`),
    face_id: atelierString(entry.face_id, `${label}.face_id`),
    visual_set_id: atelierString(entry.visual_set_id, `${label}.visual_set_id`),
    face_url: atelierString(entry.face_url, `${label}.face_url`)
  };
}

function validateAtelierActiveEntry(entry) {
  const visual = validateAtelierHomunculusVisual(entry, 'active slot');
  return {
    ...visual,
    created_week: atelierInteger(entry.created_week, 'active slot.created_week', { min: 0 }),
    affinity: atelierInteger(entry.affinity, 'active slot.affinity', { min: 0 }),
    // is_buddy marks the active child that is the current buddy (a boolean the backend sets on arrival). It is
    // validated fail-fast (missing / non-boolean throws — no default-value fill) so a broken response never hides
    // or fabricates the buddy state.
    is_buddy: atelierBoolean(entry.is_buddy, 'active slot.is_buddy'),
    parameters: validateAtelierParameters(entry.parameters, 'active slot.parameters')
  };
}

function validateAtelierNameplateEntry(entry) {
  const visual = validateAtelierHomunculusVisual(entry, 'nameplate');
  return {
    ...visual,
    epitaph: atelierString(entry.epitaph, 'nameplate.epitaph'),
    farewell_week: atelierInteger(entry.farewell_week, 'nameplate.farewell_week', { min: 0 })
  };
}

// One selectable synthesis material (the 24-entry dungeon catalog, one per element×tier): its display name, its
// element key + tier for the badge, and the held count that caps how many of it the picker can select. The name is
// the server-authoritative display name — the picker renders it verbatim and never falls back to the raw item_id.
function validateAtelierMaterialEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`atelier: material must be an object (got ${JSON.stringify(entry)})`);
  }
  return {
    item_id: atelierString(entry.item_id, 'material.item_id'),
    name: atelierString(entry.name, 'material.name'),
    element: atelierString(entry.element, 'material.element'),
    tier: atelierInteger(entry.tier, 'material.tier', { min: 1 }),
    held: atelierInteger(entry.held, 'material.held', { min: 0 })
  };
}

// The running total of a picker selection (an { item_id: quantity } map). Non-positive / non-integer entries are
// ignored so a stale or hand-cleared entry never poisons the count. Pure — shared by the picker UI and its tests.
export function atelierSelectionTotal(selection) {
  if (!selection || typeof selection !== 'object') return 0;
  return Object.values(selection).reduce((sum, qty) => (Number.isInteger(qty) && qty > 0 ? sum + qty : sum), 0);
}

// The selection map flattened into the synthesize request shape (materials: [{ item_id, quantity }]), dropping the
// zero entries the stepper leaves behind. The backend re-validates catalog membership, the exact total, and ownership.
export function atelierSelectionMaterials(selection) {
  return Object.entries(selection ?? {})
    .filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0)
    .map(([item_id, quantity]) => ({ item_id, quantity }));
}

// Whether a selection is a legal synthesis: the total is EXACTLY required_material_total AND every chosen quantity is a
// non-negative integer within its material's held count. Drives the synthesize button's enabled state (the backend
// enforces the same contract server-side). Pure — the picker UI and the contract tests share it.
export function isAtelierSelectionComplete({ selection, materials, requiredTotal }) {
  if (!Number.isInteger(requiredTotal) || requiredTotal <= 0) return false;
  if (atelierSelectionTotal(selection) !== requiredTotal) return false;
  const heldById = new Map((materials ?? []).map((material) => [material.item_id, material.held]));
  for (const [itemId, quantity] of Object.entries(selection ?? {})) {
    if (!Number.isInteger(quantity) || quantity < 0) return false;
    if (quantity > 0 && !heldById.has(itemId)) return false;
    if (quantity > (heldById.get(itemId) ?? 0)) return false;
  }
  return true;
}

// Validate + normalize the whole GET /api/atelier arrival envelope. Fail-fast on any malformed field BEFORE the
// slots / nameplates / material picker render, so a broken response never paints a partial atelier.
export function validateAtelierArrivalPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`atelier arrival: malformed payload ${JSON.stringify(payload)}`);
  }
  if (!Array.isArray(payload.active)) throw new Error(`atelier arrival: active must be an array (got ${JSON.stringify(payload.active)})`);
  if (!Array.isArray(payload.nameplates)) throw new Error(`atelier arrival: nameplates must be an array (got ${JSON.stringify(payload.nameplates)})`);
  if (!Array.isArray(payload.materials) || payload.materials.length === 0) {
    throw new Error(`atelier arrival: materials must be a non-empty array (got ${JSON.stringify(payload.materials)})`);
  }
  const maxActive = atelierInteger(payload.max_active, 'arrival.max_active', { min: 1 });
  const active = payload.active.map(validateAtelierActiveEntry);
  if (active.length > maxActive) {
    throw new Error(`atelier arrival: active count ${active.length} exceeds max_active ${maxActive}`);
  }
  return {
    week: atelierInteger(payload.week, 'arrival.week', { min: 0 }),
    active,
    nameplates: payload.nameplates.map(validateAtelierNameplateEntry),
    maxActive,
    canSynthesize: atelierBoolean(payload.can_synthesize, 'arrival.can_synthesize'),
    materials: payload.materials.map(validateAtelierMaterialEntry),
    requiredMaterialTotal: atelierInteger(payload.required_material_total, 'arrival.required_material_total', { min: 1 }),
    conversationSpent: atelierBoolean(payload.conversation_spent, 'arrival.conversation_spent'),
    postContentScreen: atelierString(payload.post_content_screen, 'arrival.post_content_screen')
  };
}

// Validate the POST /api/atelier/synthesize result (the minted child + the mode + its generated parameters + the
// consumed materials). state / inventory / content_result are opaque pass-through; the frontend consumes the child's
// identity + visual + parameters to reveal the new slot and the result view, and the consumed materials (with display
// names) to show what the synthesis spent.
export function validateAtelierSynthesisResult(payload) {
  if (!payload || typeof payload !== 'object') throw new Error(`atelier synthesize: malformed response ${JSON.stringify(payload)}`);
  const result = payload.result;
  if (!result || typeof result !== 'object') throw new Error(`atelier synthesize: response is missing result (got ${JSON.stringify(result)})`);
  const homunculus = validateAtelierHomunculusVisual(result.homunculus, 'synthesize result.homunculus');
  if (!ATELIER_SYNTHESIS_MODES.includes(result.mode)) {
    throw new Error(`atelier synthesize: result.mode must be one of ${ATELIER_SYNTHESIS_MODES.join('/')} (got ${JSON.stringify(result.mode)})`);
  }
  const consumed = result.consumed_costs;
  if (!consumed || typeof consumed !== 'object' || !Array.isArray(consumed.item_costs) || consumed.item_costs.length === 0) {
    throw new Error(`atelier synthesize: result.consumed_costs.item_costs must be a non-empty array (got ${JSON.stringify(consumed)})`);
  }
  const consumedMaterials = consumed.item_costs.map((row) => {
    if (!row || typeof row !== 'object') throw new Error(`atelier synthesize: consumed_costs.item_costs[] must be an object (got ${JSON.stringify(row)})`);
    return {
      item_id: atelierString(row.item_id, 'consumed_costs.item_costs[].item_id'),
      quantity: atelierInteger(row.quantity, 'consumed_costs.item_costs[].quantity', { min: 1 }),
      name: atelierString(row.name, 'consumed_costs.item_costs[].name')
    };
  });
  return {
    homunculus: {
      ...homunculus,
      created_week: atelierInteger(result.homunculus.created_week, 'synthesize result.homunculus.created_week', { min: 0 }),
      parameters: validateAtelierParameters(result.homunculus.parameters, 'synthesize result.homunculus.parameters')
    },
    mode: result.mode,
    consumedMaterials
  };
}

// Validate the POST /api/atelier/farewell result (the departed child's farewell speech + 銘 for the 見せ場 + the
// nameplate that arrival re-fetch will surface). A missing/empty speech or 銘 is broken state — fail fast so the
// farewell 見せ場 never opens on an empty page.
export function validateAtelierFarewellResult(payload) {
  if (!payload || typeof payload !== 'object') throw new Error(`atelier farewell: malformed response ${JSON.stringify(payload)}`);
  const result = payload.result;
  if (!result || typeof result !== 'object') throw new Error(`atelier farewell: response is missing result (got ${JSON.stringify(result)})`);
  return {
    homunculus_id: atelierString(result.homunculus_id, 'farewell result.homunculus_id'),
    display_name: atelierString(result.display_name, 'farewell result.display_name'),
    face_id: atelierString(result.face_id, 'farewell result.face_id'),
    face_url: atelierString(result.face_url, 'farewell result.face_url'),
    farewell_speech: atelierString(result.farewell_speech, 'farewell result.farewell_speech'),
    epitaph: atelierString(result.epitaph, 'farewell result.epitaph'),
    farewell_week: atelierInteger(result.farewell_week, 'farewell result.farewell_week', { min: 0 })
  };
}

// Validate the POST /api/atelier/conversation/start opening: the pre-started conversation (its id + the injected
// atelier scene the detail popup reads) and the homunculus visual summary (the non-selectable actor the daytime
// conversation renders). The situation text is the server-authoritative injected scene (conversation.visible_
// situation) — the frontend never authors a second copy. A missing scene text fails fast rather than showing an
// empty stage detail.
export function validateAtelierConversationStart(payload) {
  if (!payload || typeof payload !== 'object') throw new Error(`atelier conversation start: malformed response ${JSON.stringify(payload)}`);
  const conversation = payload.conversation;
  if (!conversation || typeof conversation !== 'object') {
    throw new Error(`atelier conversation start: response is missing the conversation (got ${JSON.stringify(conversation)})`);
  }
  if (!payload.state || typeof payload.state !== 'object') {
    throw new Error(`atelier conversation start: response is missing state (got ${JSON.stringify(payload.state)})`);
  }
  return {
    conversationId: atelierString(conversation.id, 'conversation.id'),
    locationName: atelierString(conversation.location_name, 'conversation.location_name'),
    visibleSituation: atelierString(conversation.visible_situation, 'conversation.visible_situation'),
    homunculus: validateAtelierHomunculusVisual(payload.homunculus, 'conversation start.homunculus')
  };
}
