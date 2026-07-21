import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTING_PERSONA_CHARACTER_ID,
  ROUTING_PERSONA_VARIANT_OPTIONS,
  ROUTING_PERSONA_VARIANT_IDS,
  assertKnownRoutingPersonaVariant,
  routingPersonaVariantDisplayName,
  routingPersonaVariantIconUrl,
  readPendingFinalizations,
  listFailedFinalizations,
  parseFinalizeDrainResponse,
  parseFinalizeRetryResponse,
  runFailedFinalizationRetry,
  validatePlayModeSettingsVariant,
  planPlayModeSave,
  isPlayModeLoopGuardError,
  planPlayModeSaveErrorReaction,
  describeRetryOutcome,
  playModeSaveConfirmation
} from '../public/routingFinalizeClient.js';

import { ROUTING_PERSONA_VARIANTS } from '../src/playMode.mjs';
import {
  routingPersonaDisplayName as backendRoutingPersonaDisplayName,
  ROUTING_PERSONA_CHARACTER_ID as BACKEND_CHARACTER_ID
} from '../src/routingPersona.mjs';
import { routingPersonaVisualSetId } from '../src/routingPersonaVisual.mjs';

// A queue with a failed lina job (blocking the lina subqueue), a drainable yuki job, and a later
// blocked lina job — the canonical shape for the selection/parity checks below.
function mixedQueueState() {
  return {
    pending_finalizations: [
      { conversation_id: 'conv_lina_001', character_id: 'lina', enqueued_at: '2026-06-30T00:00:00Z', status: 'failed', attempts: 2, failed_at: '2026-06-30T00:01:00Z', error: { message: 'finalize failed: LM offline' } },
      { conversation_id: 'conv_yuki_001', character_id: 'yuki', enqueued_at: '2026-06-30T00:02:00Z', status: 'pending', attempts: 0 },
      { conversation_id: 'conv_lina_002', character_id: 'lina', enqueued_at: '2026-06-30T00:03:00Z', status: 'pending', attempts: 0 }
    ]
  };
}

test('the persona variant ids + order + per-variant display names mirror the backend closed set', () => {
  assert.deepEqual(ROUTING_PERSONA_VARIANT_IDS, [...ROUTING_PERSONA_VARIANTS], 'frontend variant ids must mirror the backend closed set and order');
  assert.equal(ROUTING_PERSONA_CHARACTER_ID, BACKEND_CHARACTER_ID, 'the persona character slot must mirror the backend persona character id');
  // Every option carries its own display name (mirroring the backend per-variant name) plus a human
  // label + blurb so the chooser is selectable.
  for (const option of ROUTING_PERSONA_VARIANT_OPTIONS) {
    assert.ok(option.display_name && option.display_name.length > 0, `${option.id} needs a display name`);
    assert.equal(option.display_name, backendRoutingPersonaDisplayName(option.id), `${option.id} display name must mirror the backend`);
    assert.equal(routingPersonaVariantDisplayName(option.id), option.display_name, `${option.id} display name helper must resolve the option name`);
    assert.ok(option.label && option.label.length > 0, `${option.id} needs a label`);
    assert.ok(option.blurb && option.blurb.length > 0, `${option.id} needs a blurb`);
  }
  // The display-name helper fail-fasts on an unknown variant (no default persona name).
  assert.throws(() => routingPersonaVariantDisplayName('bogus'), /unknown routing persona variant/);
});

test('assertKnownRoutingPersonaVariant fail-fasts on an unknown/missing variant (no silent default)', () => {
  for (const variant of ROUTING_PERSONA_VARIANT_IDS) {
    assert.equal(assertKnownRoutingPersonaVariant(variant), variant);
  }
  for (const bad of [undefined, null, '', 'time-keeper', 'guidance', 'constructor', '__proto__', 42]) {
    assert.throws(() => assertKnownRoutingPersonaVariant(bad), /unknown routing persona variant/);
  }
});

test('routingPersonaVariantIconUrl points each chooser option at its own variant set neutral face, matching the backend map', () => {
  for (const variant of ROUTING_PERSONA_VARIANT_IDS) {
    // The chooser icon URL is the neutral face of the variant's own set, and the set id is exactly the
    // backend mechanical closed map (routing_lumi_<variant>) — so the settings chooser and the rendered
    // hub actor never drift onto different sets.
    assert.equal(
      routingPersonaVariantIconUrl(variant),
      `/canonical/character_visual_sets/${routingPersonaVisualSetId(variant)}/face_emotions/neutral.jpg`
    );
  }
  for (const bad of [undefined, null, '', 'routing_lumi', 'time-keeper', 42]) {
    assert.throws(() => routingPersonaVariantIconUrl(bad), /unknown routing persona variant/);
  }
});

test('readPendingFinalizations treats absent as empty and fail-fasts on a corrupt non-array', () => {
  assert.deepEqual(readPendingFinalizations(null), []);
  assert.deepEqual(readPendingFinalizations({}), []);
  assert.deepEqual(readPendingFinalizations({ pending_finalizations: [] }), []);
  assert.throws(() => readPendingFinalizations({ pending_finalizations: 'nope' }), /must be an array/);
  assert.throws(() => readPendingFinalizations({ pending_finalizations: {} }), /must be an array/);
});

test('listFailedFinalizations surfaces status/attempts/error for the retry UI', () => {
  const failed = listFailedFinalizations(mixedQueueState());
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], {
    conversation_id: 'conv_lina_001',
    character_id: 'lina',
    status: 'failed',
    attempts: 2,
    failed_at: '2026-06-30T00:01:00Z',
    error_message: 'finalize failed: LM offline'
  });
});

test('an unknown pending finalization status fail-fasts instead of being silently surfaced', () => {
  const state = { pending_finalizations: [{ conversation_id: 'conv_x', character_id: 'a', enqueued_at: 't', status: 'weird', attempts: 0 }] };
  assert.throws(() => listFailedFinalizations(state), /unknown pending finalization status/);
});

test('parseFinalizeDrainResponse accepts only the drained/idle contract and fail-fasts otherwise', () => {
  assert.deepEqual(parseFinalizeDrainResponse({ finalization_status: 'drained', drained: [{ job: {} }], state: { pending_finalizations: [] } }), {
    status: 'drained',
    drainedCount: 1,
    state: { pending_finalizations: [] }
  });
  assert.deepEqual(parseFinalizeDrainResponse({ finalization_status: 'idle', drained: [], state: { a: 1 } }), {
    status: 'idle',
    drainedCount: 0,
    state: { a: 1 }
  });
  // queued/completed/missing status, a missing drained array, or a missing state are all unexpected
  // for a finalize-next drain and fail-fast rather than continuing the drive blindly.
  assert.throws(() => parseFinalizeDrainResponse({ finalization_status: 'queued', drained: [], state: {} }), /unexpected finalization_status/);
  assert.throws(() => parseFinalizeDrainResponse({ finalization_status: 'completed', drained: [], state: {} }), /unexpected finalization_status/);
  assert.throws(() => parseFinalizeDrainResponse({ drained: [], state: {} }), /unexpected finalization_status/);
  assert.throws(() => parseFinalizeDrainResponse({ finalization_status: 'idle', state: {} }), /missing the drained array/);
  assert.throws(() => parseFinalizeDrainResponse({ finalization_status: 'idle', drained: [] }), /missing state/);
});

test('parseFinalizeRetryResponse accepts the retried/idle contract and fail-fasts on an unknown retry_status', () => {
  // retried + a drained job: the failed head record was reset and successfully re-drained.
  assert.deepEqual(parseFinalizeRetryResponse({ retry_status: 'retried', retried: { conversation_id: 'conv_a_1' }, finalization_status: 'drained', drained: [{}], state: { pending_finalizations: [] } }), {
    retryStatus: 'retried',
    retried: { conversation_id: 'conv_a_1' },
    drainedCount: 1,
    state: { pending_finalizations: [] }
  });
  // idle no-op: nothing to retry; state unchanged, retried null.
  assert.deepEqual(parseFinalizeRetryResponse({ retry_status: 'idle', retried: null, finalization_status: 'idle', drained: [], state: { pending_finalizations: [] } }), {
    retryStatus: 'idle',
    retried: null,
    drainedCount: 0,
    state: { pending_finalizations: [] }
  });
  // an unknown / missing retry_status, or a malformed drain payload, fail-fast.
  assert.throws(() => parseFinalizeRetryResponse({ retry_status: 'queued', finalization_status: 'idle', drained: [], state: {} }), /unexpected retry_status/);
  assert.throws(() => parseFinalizeRetryResponse({ finalization_status: 'idle', drained: [], state: {} }), /unexpected retry_status/);
  assert.throws(() => parseFinalizeRetryResponse({ retry_status: 'retried', finalization_status: 'nope', drained: [], state: {} }), /unexpected finalization_status/);
  assert.throws(() => parseFinalizeRetryResponse({ retry_status: 'idle', finalization_status: 'idle', drained: [] }), /missing state/);
});

// ---- behavioral (executed) coverage of the orchestration cores ----

test('runFailedFinalizationRetry POSTs the retry, persists state, and returns the parsed outcome', async () => {
  // retried + drained: the failed head record was reset and re-drained; state persisted, outcome reported.
  let state = { pending_finalizations: [{ conversation_id: 'conv_lina_1', character_id: 'lina', enqueued_at: 't', status: 'failed', attempts: 1, error: { message: 'x' } }] };
  const seen = [];
  const okResult = await runFailedFinalizationRetry({
    characterId: 'lina',
    retry: async (id) => { seen.push(id); return { retry_status: 'retried', retried: { conversation_id: 'conv_lina_1' }, finalization_status: 'drained', drained: [{}], state: { pending_finalizations: [] } }; },
    writeState: (s) => { state = s; }
  });
  assert.deepEqual(seen, ['lina'], 'the transport is called with the character id');
  assert.equal(okResult.retryStatus, 'retried');
  assert.equal(okResult.drainedCount, 1);
  assert.deepEqual(state, { pending_finalizations: [] }, 'the persisted state reflects the cleared queue');

  // idle no-op: state still persisted (unchanged), outcome idle.
  const idleResult = await runFailedFinalizationRetry({
    characterId: 'lina',
    retry: async () => ({ retry_status: 'idle', retried: null, finalization_status: 'idle', drained: [], state: { pending_finalizations: [] } }),
    writeState: () => {}
  });
  assert.equal(idleResult.retryStatus, 'idle');
  assert.equal(idleResult.drainedCount, 0);

  // a transport failure / unknown retry_status propagates (the caller surfaces it).
  await assert.rejects(() => runFailedFinalizationRetry({ characterId: 'lina', retry: async () => { throw new Error('boom'); }, writeState: () => {} }), /boom/);
  await assert.rejects(() => runFailedFinalizationRetry({ characterId: 'lina', retry: async () => ({ retry_status: 'weird', finalization_status: 'idle', drained: [], state: {} }), writeState: () => {} }), /unexpected retry_status/);
  // a missing transport / character id fail-fasts.
  await assert.rejects(() => runFailedFinalizationRetry({ characterId: '', retry: async () => ({}), writeState: () => {} }), /characterId is required/);
  await assert.rejects(() => runFailedFinalizationRetry({ characterId: 'lina', retry: null, writeState: () => {} }), /retry transport is required/);
});

test('planPlayModeSave requires an explicit known variant for routing and none for loop', () => {
  assert.deepEqual(planPlayModeSave({ mode: 'loop', selectedVariant: null }), { ok: true, body: { mode: 'loop' } });
  assert.deepEqual(planPlayModeSave({ mode: 'routing', selectedVariant: 'fallen_star' }), { ok: true, body: { mode: 'routing', routing_persona_variant: 'fallen_star' } });
  // routing with no chosen variant is blocked (the caller prompts; it does NOT PATCH a default).
  assert.deepEqual(planPlayModeSave({ mode: 'routing', selectedVariant: null }), { ok: false, reason: 'variant-required' });
  assert.deepEqual(planPlayModeSave({ mode: 'routing', selectedVariant: '' }), { ok: false, reason: 'variant-required' });
  // an unknown variant / unknown mode fail-fast.
  assert.throws(() => planPlayModeSave({ mode: 'routing', selectedVariant: 'bogus' }), /unknown routing persona variant/);
  assert.throws(() => planPlayModeSave({ mode: 'spectate', selectedVariant: null }), /unknown play mode/);
});

test('isPlayModeLoopGuardError identifies only the 409 (A) guard rejection', () => {
  assert.equal(isPlayModeLoopGuardError({ statusCode: 409 }), true);
  for (const status of [400, 404, 500, undefined]) {
    assert.equal(isPlayModeLoopGuardError({ statusCode: status }), false);
  }
  assert.equal(isPlayModeLoopGuardError(null), false);
});

test('planPlayModeSaveErrorReaction routes a 409 to the loop-guard display and everything else to rethrow', () => {
  // 409 = (A) guard: surface the reason and keep the UI on routing (the caller does not lose the choice).
  assert.deepEqual(planPlayModeSaveErrorReaction({ statusCode: 409, message: 'cannot switch to loop while a routing finalize promotion is incomplete' }), {
    kind: 'loop-guard',
    message: 'cannot switch to loop while a routing finalize promotion is incomplete'
  });
  // any other error is surfaced + rethrown by the caller.
  for (const error of [{ statusCode: 400, message: 'bad' }, { statusCode: 500 }, new Error('network'), null]) {
    assert.deepEqual(planPlayModeSaveErrorReaction(error), { kind: 'error' });
  }
});

test('describeRetryOutcome maps the retry result to idle / completed / unresolved (and fail-fasts on a bad status)', () => {
  assert.equal(describeRetryOutcome({ retryStatus: 'idle', drainedCount: 0 }), 'idle');
  assert.equal(describeRetryOutcome({ retryStatus: 'retried', drainedCount: 1 }), 'completed');
  // retried but nothing drained = re-failed, still needs attention.
  assert.equal(describeRetryOutcome({ retryStatus: 'retried', drainedCount: 0 }), 'unresolved');
  assert.throws(() => describeRetryOutcome({ retryStatus: 'queued', drainedCount: 0 }), /unexpected retryStatus/);
});

test('playModeSaveConfirmation returns the save-success message without re-prompting the persona selection', () => {
  // A routing SUCCESS means a variant was already chosen (planPlayModeSave gated it), so the
  // confirmation must NOT append the "案内役のペルソナを1つ選んでください。" prompt — that prompt is the
  // variant-required (unsaved) guidance, asserted by planPlayModeSave returning { ok: false }.
  assert.equal(playModeSaveConfirmation('routing'), 'モードをルーティングで保存しました。');
  assert.equal(playModeSaveConfirmation('loop'), 'モードをループで保存しました。');
  assert.doesNotMatch(playModeSaveConfirmation('routing'), /案内役のペルソナを1つ選んでください。/);
  assert.throws(() => playModeSaveConfirmation('spectate'), /unknown play mode/);
  // The variant-required prompt is the other half of the "出し分け": routing with no variant does not
  // save and is reported for the caller to prompt the selection (no silent default).
  assert.deepEqual(planPlayModeSave({ mode: 'routing', selectedVariant: null }), { ok: false, reason: 'variant-required' });
});

test('validatePlayModeSettingsVariant resolves known variants, prompts (null) on an out-of-set variant, and fail-fasts on a missing one', () => {
  assert.equal(validatePlayModeSettingsVariant({ mode: 'loop' }), null);
  assert.equal(validatePlayModeSettingsVariant({ mode: 'routing', routing_persona_variant: 'hourglass_grain' }), 'hourglass_grain');
  assert.equal(validatePlayModeSettingsVariant({ mode: 'loop', routing_persona_variant: 'fallen_star' }), 'fallen_star');
  // A routing payload MISSING the variant key entirely is malformed and fail-fasts.
  assert.throws(() => validatePlayModeSettingsVariant({ mode: 'routing' }), /routing mode is missing routing_persona_variant/);
  // A persisted variant outside the current closed set (pre-replacement install) resolves to null — the
  // chooser renders unselected so the player re-selects (recovery). It is NOT mapped or defaulted, and
  // this holds for both routing and loop payloads.
  assert.equal(validatePlayModeSettingsVariant({ mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }), null);
  assert.equal(validatePlayModeSettingsVariant({ mode: 'loop', routing_persona_variant: 'bogus' }), null);
});
