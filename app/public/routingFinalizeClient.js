// Pure routing-mode finalize-queue + persona-variant client logic, shared by app.js and headless
// unit tests so the fail-fast paths are verifiable without a browser. These mirror the backend
// contracts (app/src/routingFinalizeQueue.mjs selection rules, app/src/playMode.mjs
// ROUTING_PERSONA_VARIANTS, app/src/routingPersona.mjs per-variant display name + character slot)
// without importing server code into the browser bundle.

// The routing persona reuses the `lina` character slot, so its pending finalization is keyed by this
// character id (mirrors app/src/routingPersona.mjs ROUTING_PERSONA_CHARACTER_ID).
export const ROUTING_PERSONA_CHARACTER_ID = 'lina';

// The ten selectable persona variants, in the same order as the backend ROUTING_PERSONA_VARIANTS
// (fallen_star is the default, first). `id` is the backend variant id (the only value persisted via
// PATCH /api/settings/play-mode); `display_name` is the variant's proper name (mirrors the backend
// routingPersonaVariants display_name — fallen_star is「ルミ」with no surname); `label` / `blurb` are
// display copy. The name follows the variant — each variant has its own name, memory-peek self-text,
// and visual set; only the slot (`lina`) is shared.
export const ROUTING_PERSONA_VARIANT_OPTIONS = Object.freeze([
  Object.freeze({ id: 'fallen_star', display_name: 'ルミ', label: '名を失くした流れ星', blurb: '星降り祭の夜に名前を落とした小さな星。人懐こく、あなたの一週間の輝きを我がことのように喜ぶ。' }),
  Object.freeze({ id: 'bureau_apprentice', display_name: 'リステ・ドリームレッジ', label: '夢の管理局の見習い', blurb: '夢の管理局から来た史上最年少の見習い。規定に懸命で、想定外にはあわてるが、持ち場への誇りは高い。' }),
  Object.freeze({ id: 'dethroned_constellation', display_name: 'アステリア・スタークラウン', label: '空から降ろされた星座', blurb: '名を忘れられ星の座を降りた元・星座。尊大な姫のようで、毎週の来訪を認めないまま心待ちにする。' }),
  Object.freeze({ id: 'scale_arbiter', display_name: 'ユスティ・フェアウェイト', label: '天秤の裁定精', blurb: 'かつて旅人の道を量った裁定の精。骨の髄まで公平で、どの選択も等しく肯定してくれる。' }),
  Object.freeze({ id: 'pool_cat', display_name: 'ネル・グロウパドル', label: '光だまりの猫のようなもの', blurb: '月光だまりで眠っていた正体不明の何か。猫気質で素っ気ないが、気を許した相手の変化には聡い。' }),
  Object.freeze({ id: 'far_side_sister', display_name: 'ノクテ・ヴェイルサイド', label: '月の裏の妹', blurb: '表の姉に代わって立つ月の裏の妹。人前は苦手だが観察眼は鋭く、小さな変化に真っ先に気付く。' }),
  Object.freeze({ id: 'eclipse_shadow', display_name: 'ウンブラ・カッパーグロウ', label: '月蝕の影', blurb: '月を覆う蝕の影そのもの。影ながら明るい面を見て、見てもらえること・名を呼ばれることに素直に感激する。' }),
  Object.freeze({ id: 'hourglass_grain', display_name: 'サラ・アワーグラス', label: '砂時計の一粒', blurb: 'くびれに引っかかった時間の一粒。焦らず急かさず、進みあぐねた週にこそそっと寄り添う。' }),
  Object.freeze({ id: 'star_egg_keeper', display_name: 'ニンナ・スターネスト', label: '星の卵の抱き手', blurb: '星の卵を温める精。桁違いに長い物差しで、急がず見放さず、小さな成長を見つける母性の持ち主。' }),
  Object.freeze({ id: 'stardust_sweeper', display_name: 'シュシュ・スターブルーム', label: '星屑の掃き手', blurb: '星屑を掃き集めてきた箒の精。倹約家で、あなたのわずかな頑張りも塵ひとつ分から数えて褒める。' })
]);

export const ROUTING_PERSONA_VARIANT_IDS = Object.freeze(ROUTING_PERSONA_VARIANT_OPTIONS.map((option) => option.id));

// The display name for a persona variant. An unknown variant fail-fasts (no default persona name),
// mirroring the backend routingPersonaDisplayName.
export function routingPersonaVariantDisplayName(variant) {
  const option = ROUTING_PERSONA_VARIANT_OPTIONS.find((entry) => entry.id === assertKnownRoutingPersonaVariant(variant));
  return option.display_name;
}

// A persona variant must be one of the known ids — an unknown/missing variant fail-fasts rather than
// silently selecting a default (routing mode requires an explicit variant).
export function assertKnownRoutingPersonaVariant(variant) {
  if (!ROUTING_PERSONA_VARIANT_IDS.includes(variant)) {
    throw new Error(`unknown routing persona variant: ${JSON.stringify(variant)}`);
  }
  return variant;
}

// The canonical neutral-face icon URL for a persona variant, shown in the settings chooser so the player
// can see which guide each option is. Mirrors the backend mechanical closed map (variant `<v>` → set
// `routing_lumi_<v>`, app/src/routingPersonaVisual.mjs routingPersonaVisualSetId) and the canonical face
// URL shape (app/src/characterCatalog.mjs publicCanonicalFaceUrl) without importing server code. An
// unknown variant fail-fasts rather than pointing at a nonexistent set.
export function routingPersonaVariantIconUrl(variant) {
  return `/canonical/character_visual_sets/routing_lumi_${assertKnownRoutingPersonaVariant(variant)}/face_emotions/neutral.jpg`;
}

// Read runtime_state.pending_finalizations. Absent is an empty queue; a present non-array value is a
// corrupt state and fail-fasts (mirrors the backend invalid_pending_finalizations guard) rather than
// being coerced away.
export function readPendingFinalizations(state) {
  if (!state || typeof state !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(state, 'pending_finalizations')) return [];
  const pending = state.pending_finalizations;
  if (!Array.isArray(pending)) {
    throw new Error('runtime_state.pending_finalizations must be an array when present');
  }
  return pending;
}

function pendingFinalizationStatus(job) {
  const status = String(job?.status ?? '').trim();
  if (status !== 'pending' && status !== 'failed') {
    throw new Error(`unknown pending finalization status: ${JSON.stringify(job?.status)}`);
  }
  return status;
}

// The failed jobs, surfaced for the retry UI with their status / attempts / error message (the full
// status/attempts/error display contract).
export function listFailedFinalizations(state) {
  return readPendingFinalizations(state)
    .filter((job) => pendingFinalizationStatus(job) === 'failed')
    .map((job) => ({
      conversation_id: job.conversation_id,
      character_id: job.character_id,
      status: pendingFinalizationStatus(job),
      attempts: job.attempts,
      failed_at: job.failed_at ?? null,
      error_message: job?.error?.message ?? null
    }));
}

// Validate the drain payload shared by the finalize/retry response. The backend returns
// finalization_status 'drained' (a job was drained) or 'idle' (the queue is empty); any other status, a
// missing drained array, or a missing state is unexpected and fail-fasts rather than continuing blindly.
export function parseFinalizeDrainResponse(result) {
  const status = result?.finalization_status;
  if (status !== 'drained' && status !== 'idle') {
    throw new Error(`finalize drain: unexpected finalization_status ${JSON.stringify(status)}`);
  }
  if (!Array.isArray(result?.drained)) {
    throw new Error('finalize drain: response is missing the drained array');
  }
  if (!result?.state || typeof result.state !== 'object') {
    throw new Error('finalize drain: response is missing state');
  }
  return { status, drainedCount: result.drained.length, state: result.state };
}

// Validate a /api/conversation/finalize/retry response. It is the drain payload (finalization_status
// / drained / state) plus `retry_status`: 'retried' (the character's failed head record was reset to
// pending and re-drained — drained on success, left failed with attempts++ on re-failure) or 'idle'
// (no failed record to retry, or one blocked behind a preceding pending). An unknown retry_status, or
// a malformed drain payload, fail-fasts rather than continuing on an ambiguous response.
export function parseFinalizeRetryResponse(result) {
  const retryStatus = result?.retry_status;
  if (retryStatus !== 'retried' && retryStatus !== 'idle') {
    throw new Error(`finalize retry: unexpected retry_status ${JSON.stringify(retryStatus)}`);
  }
  const drain = parseFinalizeDrainResponse(result);
  return { retryStatus, retried: result.retried ?? null, drainedCount: drain.drainedCount, state: drain.state };
}

// Drive a failed character's retry against an injected transport: POST the retry, validate the
// response (parseFinalizeRetryResponse, which fail-fasts on an unknown retry_status / malformed drain
// payload), persist the new state via writeState, and return the parsed outcome. A transport or
// validation error propagates so the caller surfaces it (never swallowed). Pure + injectable so the
// retry data path is verifiable without a DOM.
export async function runFailedFinalizationRetry({ characterId, retry, writeState }) {
  if (typeof retry !== 'function') throw new Error('runFailedFinalizationRetry: retry transport is required');
  const id = String(characterId ?? '').trim();
  if (!id) throw new Error('runFailedFinalizationRetry: characterId is required');
  const parsed = parseFinalizeRetryResponse(await retry(id));
  if (typeof writeState === 'function') writeState(parsed.state);
  return parsed;
}

// Resolve which persona variant the settings chooser should pre-select from a play-mode settings
// payload. A known variant returns itself. A persisted variant that is not in the current closed set
// (e.g. left by an install predating a closed-set replacement) is NOT silently mapped or defaulted — it
// resolves to null so the settings screen renders the chooser unselected and the player re-selects
// (recovery); routing ops still fail-fast at the point of use. A routing payload MISSING the variant
// key entirely is malformed and fail-fasts. A loop payload with no variant legitimately returns null.
export function validatePlayModeSettingsVariant(settings) {
  if (Object.prototype.hasOwnProperty.call(settings ?? {}, 'routing_persona_variant')) {
    const variant = settings.routing_persona_variant;
    return ROUTING_PERSONA_VARIANT_IDS.includes(variant) ? variant : null;
  }
  if (settings?.mode === 'routing') {
    throw new Error('play mode settings: routing mode is missing routing_persona_variant');
  }
  return null;
}

// Decide the PATCH body for a play-mode save. Routing requires an explicit, known persona variant — an
// unselected routing variant is reported as `{ ok: false, reason: 'variant-required' }` (the caller
// prompts the player and does NOT PATCH a silent default); an unknown variant fail-fasts. Loop needs
// no variant.
export function planPlayModeSave({ mode, selectedVariant }) {
  if (mode !== 'loop' && mode !== 'routing') {
    throw new Error(`unknown play mode: ${JSON.stringify(mode)}`);
  }
  if (mode === 'loop') return { ok: true, body: { mode } };
  if (!selectedVariant) return { ok: false, reason: 'variant-required' };
  return { ok: true, body: { mode, routing_persona_variant: assertKnownRoutingPersonaVariant(selectedVariant) } };
}

// The (A) guard: a switch-to-loop PATCH is rejected with HTTP 409 while a routing finalize promotion is
// still incomplete. Identified by status so the caller can surface the reason + keep the UI on routing.
export function isPlayModeLoopGuardError(error) {
  return error?.statusCode === 409;
}

// Decide how the UI should react to a play-mode save error. A 409 is the (A) guard: report
// `{ kind: 'loop-guard', message }` so the caller shows the reason and keeps the UI on routing (the
// choice is not silently lost). Any other error is `{ kind: 'error' }` — the caller surfaces it and
// rethrows. Pure, so the 409-guard-vs-rethrow branch is verifiable without the DOM.
export function planPlayModeSaveErrorReaction(error) {
  if (isPlayModeLoopGuardError(error)) {
    return { kind: 'loop-guard', message: String(error?.message ?? '') };
  }
  return { kind: 'error' };
}

// Interpret a finalize-retry outcome into a display state: 'idle' (nothing to retry), 'completed' (the
// failed record was reset and drained), or 'unresolved' (it was retried but re-failed and still
// needs attention). Pure, so the retry result→message decision is verifiable without the DOM.
export function describeRetryOutcome({ retryStatus, drainedCount }) {
  if (retryStatus === 'idle') return 'idle';
  if (retryStatus !== 'retried') {
    throw new Error(`describeRetryOutcome: unexpected retryStatus ${JSON.stringify(retryStatus)}`);
  }
  return drainedCount > 0 ? 'completed' : 'unresolved';
}

// The confirmation message shown after a SUCCESSFUL play-mode save. A routing success means a persona
// variant was already chosen (planPlayModeSave gated the save on it), so the confirmation must not
// re-prompt the selection — the "案内役のペルソナを1つ選んでください。" prompt belongs only to the
// variant-required (unsaved) state. Pure, so the save→message decision is verifiable without the DOM.
export function playModeSaveConfirmation(mode) {
  if (mode === 'routing') return 'モードをルーティングで保存しました。';
  if (mode === 'loop') return 'モードをループで保存しました。';
  throw new Error(`playModeSaveConfirmation: unknown play mode ${JSON.stringify(mode)}`);
}
