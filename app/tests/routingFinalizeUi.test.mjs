import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';

const publicRoot = runtimePublicReferenceRoot;

async function readPublic(name) {
  return await readFile(path.join(publicRoot, name), 'utf8');
}

// The failed-finalization retry behavioral core (POST + parse + state persist) is executed/asserted in
// routingFinalizeClient.test.mjs. These tests assert the app.js glue: that the browser wires those pure
// functions to the real DOM + fetch transport, and that the recovery surface lives in its own settings
// category with its own status line.

test('the conversation post-processing (finalize) recovery category exposes its own panel and status line', async () => {
  const html = await readPublic('index.html');
  // The recovery surface is its own settings category (routing is the official mode, so there is no
  // loop/routing play-mode card hosting it).
  assert.match(html, /<button id="settings-category-conversation-finalize"[^>]*data-settings-category="conversation-finalize"[^>]*>会話後処理<\/button>/, 'a dedicated 会話後処理 category tab exists');
  assert.match(html, /<section id="settings-panel-conversation-finalize"[^>]*data-settings-category="conversation-finalize"[^>]*hidden>/, 'the 会話後処理 category panel exists and starts hidden');
  assert.match(html, /<p id="conversation-finalize-settings-status"/, 'the finalize category has its own status line (not borrowed from a play-mode panel)');
  assert.match(html, /<div id="routing-finalize-panel"[^>]*hidden>/, 'the failed-finalization panel lives in this category and starts hidden');
  assert.match(html, /<ul id="routing-finalize-failed-list"/, 'failed-finalization list');
  // Drain-on-exit removes the pre-conversation entry wait; the banner must be gone from the DOM.
  assert.doesNotMatch(html, /id="routing-finalize-wait"/, 'the pre-conversation finalize wait banner is removed (drain-on-exit runs no entry pre-drain)');
});

test('the removed loop/routing play-mode settings card leaves no trace in the settings markup', async () => {
  const html = await readPublic('index.html');
  assert.doesNotMatch(html, /settings-panel-play-mode|settings-category-play-mode|play-mode-settings-form|id="play-mode-loop"|id="play-mode-routing"|play-mode-loop-guard-error/, 'the mode radios / guard line / play-mode panel are removed');
  assert.doesNotMatch(html, /routing-persona-variant-group|routing-persona-variant-options|active-slot-persona-group|active-slot-persona-options/, 'the routing persona choosers (new-game default + active-slot) are removed');
});

test('the browser script imports only the finalize retry helpers (no play-mode planning / persona helpers)', async () => {
  const js = await readPublic('app.js');
  assert.match(js, /import \{[\s\S]*listFailedFinalizations[\s\S]*runFailedFinalizationRetry[\s\S]*describeRetryOutcome[\s\S]*\} from '\.\/routingFinalizeClient\.js'/, 'app.js imports the retry helpers it delegates to');
  // The play-mode card + persona choosers are removed, so their planning / validation / persona helpers are
  // no longer imported anywhere in the browser script.
  assert.doesNotMatch(js, /validatePlayModeSettingsVariant|planPlayModeSave|planPlayModeSaveErrorReaction|playModeSaveConfirmation|ROUTING_PERSONA_VARIANT_OPTIONS|ROUTING_PERSONA_VARIANT_IDS|routingPersonaVariantDisplayName|routingPersonaVariantIconUrl/, 'the removed play-mode / persona helpers must not be imported or referenced');
  // Drain-on-exit removed the background idle drain and the entry pre-drain wait, so their helpers are
  // no longer imported or referenced anywhere in the browser script.
  assert.doesNotMatch(js, /runIdleFinalizeDrain|hasDrainableFinalizationForCharacter/, 'the removed idle-drain / entry-wait helpers must not be imported');
});

test('drain-on-exit: no background idle drain and no entry pre-drain wait remain in the browser script', async () => {
  const js = await readPublic('app.js');
  // The idle drain machinery (showScreen hook, drive, screen set, conversation-active gate) is removed.
  assert.doesNotMatch(js, /maybeDriveRoutingIdleFinalizeDrain|driveRoutingIdleFinalizeDrain|ROUTING_IDLE_FINALIZE_SCREENS|routingConversationIsActive|routingIdleFinalizeDrainInFlight|finalize-next/, 'the background idle drain and its finalize-next transport are removed');
  // The entry pre-drain wait (banner + wrapper) is removed; the entries POST directly.
  assert.doesNotMatch(js, /withRoutingFinalizeEntryWait|setRoutingFinalizeWaitVisible/, 'the entry pre-drain wait wrapper and banner toggle are removed');
  assert.match(js, /const result = await postJson\('\/api\/routing\/hub\/start', \{\}\);/, 'hub entry POSTs the start directly (no entry pre-drain wait)');
  assert.match(js, /const result = await postJson\('\/api\/interaction\/start', \{ character_id: characterId, source_type: 'field' \}\);/, 'interaction start POSTs directly (no entry pre-drain wait)');
});

test('the finalize recovery panel renders on settings open from the current runtime state', async () => {
  const js = await readPublic('app.js');
  assert.match(js, /function openSettingsScreen\(\)\s*\{[\s\S]*?renderRoutingFinalizePanel\(\);[\s\S]*?\n\}/, 'opening settings renders the finalize panel');
});

test('the failed-finalization retry drives the dedicated retry endpoint, shows status/attempts/error, and surfaces failures', async () => {
  const js = await readPublic('app.js');
  assert.match(js, /function renderRoutingFinalizePanel\(\) \{[\s\S]*listFailedFinalizations\(currentRuntimeState\)[\s\S]*panel\.hidden = failed\.length === 0;/, 'the panel renders the failed jobs and hides when none');
  assert.match(js, /meta\.textContent = `\$\{job\.character_id\}／状態: \$\{job\.status\}／\$\{job\.attempts\}回失敗/, 'the failed entry shows status, attempts (and error on its own line)');
  assert.match(js, /errorLine\.textContent = job\.error_message/, 'the failed entry shows the error message');
  assert.match(js, /retry\.addEventListener\('click', \(\) => \{ retryRoutingFinalization\(job\.character_id, retry\)/, 'each failed entry has a retry control');
  // The retry POSTs the dedicated retry endpoint with a body { character_id } (no query), through the
  // behaviorally-tested runFailedFinalizationRetry (POST + parse + state persist).
  assert.match(js, /retry = await runFailedFinalizationRetry\(\{\s*\n\s*characterId,\s*\n\s*retry: \(id\) => postJson\('\/api\/conversation\/finalize\/retry', \{ character_id: id \}\),\s*\n\s*writeState: \(state\) => \{ currentRuntimeState = state \?\? currentRuntimeState; \}\s*\n\s*\}\)/, 'retry drives POST /api/conversation/finalize/retry with a body character_id via the injectable retry core');
  // The retry status uses the finalize category's own status line, not a play-mode panel's.
  assert.match(js, /setConversationFinalizeSettingsStatus\(`\$\{characterId\} の後処理を再試行しています…`\)/, 'the retry status writes the finalize category status line');
  // describeRetryOutcome interprets the result; the glue maps idle/completed/unresolved to a message.
  assert.match(js, /const outcome = describeRetryOutcome\(retry\);\s*\n\s*if \(outcome === 'idle'\) \{[\s\S]*再試行できる失敗はありませんでした。[\s\S]*\} else if \(outcome === 'completed'\) \{[\s\S]*再試行し、完了しました。[\s\S]*\} else \{[\s\S]*まだ完了していません/, 'the retry outcome message distinguishes idle / completed / unresolved');
  assert.match(js, /catch \(error\) \{[\s\S]*refreshRoutingFinalizeStateAfterError\(\);[\s\S]*reportError\(error\);/, 'a retry failure is surfaced, not swallowed');
});
