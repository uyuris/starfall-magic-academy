import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { canHandleSaveLoadApiRoute } from '../src/server/saveLoadApi.mjs';
import { canHandleLmStudioSettingsRoute } from '../src/server/lmStudioSettingsApi.mjs';
import { canHandlePlayModeSettingsRoute } from '../src/server/playModeSettingsApi.mjs';
import { canHandleRoutingHubRoute } from '../src/server/routingHubApi.mjs';
import { canHandleFlagDebugRoute } from '../src/server/flagDebugApi.mjs';
import { canHandleAuthoringApiRoute } from '../src/server/authoringApi.mjs';
import { canHandlePlaySessionFieldApiRoute } from '../src/server/playSessionFieldApi.mjs';
import { canHandleProgressionEconomyApiRoute } from '../src/server/progressionEconomyApi.mjs';
import { canHandleInteractionContinuityApiRoute } from '../src/server/interactionContinuityApi.mjs';
import { canHandleAssetCompositeApiRoute } from '../src/server/assetCompositeApi.mjs';
import { canHandleConversationLifecycleApiRoute } from '../src/server/conversationLifecycleApi.mjs';
import { canHandleConversationStreamingApiRoute } from '../src/server/conversationStreamingApi.mjs';
import { serveStatic } from '../src/server/staticServing.mjs';
import { sendJson, readBody, openSse, sendSseEvent } from '../src/server/httpHelpers.mjs';

const serverEntrypointUrl = new URL('../src/server.mjs', import.meta.url);

test('save/load slot routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/save-slots/);
  assert.doesNotMatch(serverSource, /\/api\/save'/);
  assert.doesNotMatch(serverSource, /\/api\/slots\//);
  assert.equal(canHandleSaveLoadApiRoute('GET', '/api/save-slots'), true);
  assert.equal(canHandleSaveLoadApiRoute('POST', '/api/save'), true);
  assert.equal(canHandleSaveLoadApiRoute('POST', '/api/load'), false);
  assert.equal(canHandleSaveLoadApiRoute('POST', '/api/slots/load'), true);
  assert.equal(canHandleSaveLoadApiRoute('PATCH', '/api/slots/slot_001/note'), true);
  assert.equal(canHandleSaveLoadApiRoute('DELETE', '/api/slots/slot_001'), true);
  assert.equal(canHandleSaveLoadApiRoute('GET', '/api/world'), false);
});

test('LM Studio settings routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/settings\/lmstudio/);
  assert.doesNotMatch(serverSource, /\/api\/settings\/lmstudio\/models/);
  assert.equal(canHandleLmStudioSettingsRoute('GET', '/api/settings/lmstudio'), true);
  assert.equal(canHandleLmStudioSettingsRoute('PATCH', '/api/settings/lmstudio'), true);
  assert.equal(canHandleLmStudioSettingsRoute('POST', '/api/settings/lmstudio/models'), true);
  assert.equal(canHandleLmStudioSettingsRoute('GET', '/api/world'), false);
});

test('play mode settings routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/settings\/play-mode/);
  assert.equal(canHandlePlayModeSettingsRoute('GET', '/api/settings/play-mode'), true);
  assert.equal(canHandlePlayModeSettingsRoute('PATCH', '/api/settings/play-mode'), true);
  assert.equal(canHandlePlayModeSettingsRoute('POST', '/api/settings/play-mode'), false);
  assert.equal(canHandlePlayModeSettingsRoute('GET', '/api/settings/lmstudio'), false);
});

test('routing hub routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/routing\/hub\/start/);
  assert.equal(canHandleRoutingHubRoute('POST', '/api/routing/hub/start'), true);
  assert.equal(canHandleRoutingHubRoute('GET', '/api/routing/hub/start'), false);
  assert.equal(canHandleRoutingHubRoute('POST', '/api/settings/play-mode'), false);
});

test('flag and debug routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/flags(?:\/|')/);
  assert.doesNotMatch(serverSource, /\/api\/event-flags(?:\/|')/);
  assert.doesNotMatch(serverSource, /\/api\/debug\/llm-requests/);
  assert.doesNotMatch(serverSource, /\/api\/debug\/relationships/);
  assert.doesNotMatch(serverSource, /\/api\/debug\/weeks/);
  assert.equal(canHandleFlagDebugRoute('GET', '/api/flags'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/flags/set'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/flags/judgment-flow'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/event-flags/completion/set'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/event-flags/start'), true);
  assert.equal(canHandleFlagDebugRoute('GET', '/api/debug/llm-requests'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/debug/relationships'), true);
  assert.equal(canHandleFlagDebugRoute('POST', '/api/debug/weeks'), true);
  assert.equal(canHandleFlagDebugRoute('GET', '/api/world'), false);
});

test('world and character authoring routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/characters(?:\/|')/);
  assert.doesNotMatch(serverSource, /\/api\/world(?:\/|')/);
  assert.equal(canHandleAuthoringApiRoute('GET', '/api/characters'), true);
  assert.equal(canHandleAuthoringApiRoute('POST', '/api/characters/profile'), true);
  assert.equal(canHandleAuthoringApiRoute('GET', '/api/world'), true);
  assert.equal(canHandleAuthoringApiRoute('POST', '/api/world'), true);
  assert.equal(canHandleAuthoringApiRoute('POST', '/api/training/run'), false);
});

test('play/session and field routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/new-game/);
  assert.doesNotMatch(serverSource, /\/api\/state(?:\/|')/);
  assert.doesNotMatch(serverSource, /\/api\/field(?:\/|')/);
  assert.equal(canHandlePlaySessionFieldApiRoute('POST', '/api/new-game'), true);
  assert.equal(canHandlePlaySessionFieldApiRoute('GET', '/api/state'), true);
  assert.equal(canHandlePlaySessionFieldApiRoute('GET', '/api/field'), true);
  assert.equal(canHandlePlaySessionFieldApiRoute('POST', '/api/field/move'), true);
  assert.equal(canHandlePlaySessionFieldApiRoute('POST', '/api/training/run'), false);
});

test('academy progression and economy routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/training\/run'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/academy\/week\/start'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/inventory'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/inventory\/use'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/gathering'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/gathering\/collect'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/shop'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/shop\/buy'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/shop\/sell'/);

  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/training/run'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/academy/week/start'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('GET', '/api/inventory'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/inventory/use'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('GET', '/api/gathering'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/gathering/collect'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('GET', '/api/shop'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/shop/buy'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('POST', '/api/shop/sell'), true);
  assert.equal(canHandleProgressionEconomyApiRoute('GET', '/api/records/status'), false);
});

test('interaction and continuity routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/interaction\/start'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/records\/status'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/records\/reset'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/prompt-preview'/);

  assert.equal(canHandleInteractionContinuityApiRoute('POST', '/api/interaction/start'), true);
  assert.equal(canHandleInteractionContinuityApiRoute('GET', '/api/records/status'), true);
  assert.equal(canHandleInteractionContinuityApiRoute('POST', '/api/records/reset'), true);
  assert.equal(canHandleInteractionContinuityApiRoute('GET', '/api/prompt-preview'), true);
  assert.equal(canHandleInteractionContinuityApiRoute('GET', '/api/assets'), false);
});

test('retired asset-composite routes remain absent from the runtime surface', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/assets'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/character-composite'/);

  assert.equal(canHandleAssetCompositeApiRoute('GET', '/api/assets'), false);
  assert.equal(canHandleAssetCompositeApiRoute('GET', '/api/character-composite'), false);
  assert.equal(canHandleAssetCompositeApiRoute('POST', '/api/conversation'), false);
});

test('non-stream conversation lifecycle routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation\/opening'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation'(?!.+stream)/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation\/edit-user-message'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation\/end'/);

  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/opening'), true);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation'), true);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/edit-user-message'), true);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/finalize/retry'), true);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/end'), true);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/stream'), false);
  // Drain-on-exit removed the idle/entry drain endpoints, so they no longer match a lifecycle route.
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/finalize-next'), false);
  assert.equal(canHandleConversationLifecycleApiRoute('POST', '/api/conversation/finalize'), false);
});

test('streaming conversation routes are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation\/opening\/stream'/);
  assert.doesNotMatch(serverSource, /url\.pathname === '\/api\/conversation\/stream'/);

  assert.equal(canHandleConversationStreamingApiRoute('POST', '/api/conversation/opening/stream'), true);
  assert.equal(canHandleConversationStreamingApiRoute('POST', '/api/conversation/stream'), true);
  assert.equal(canHandleConversationStreamingApiRoute('POST', '/api/conversation/end'), false);
});

test('static serving and HTTP helpers are extracted from the monolithic server entrypoint', async () => {
  const serverSource = await fs.readFile(serverEntrypointUrl, 'utf8');
  assert.doesNotMatch(serverSource, /function sendJson\(/);
  assert.doesNotMatch(serverSource, /async function readBody\(/);
  assert.doesNotMatch(serverSource, /function openSse\(/);
  assert.doesNotMatch(serverSource, /function sendSseEvent\(/);
  assert.doesNotMatch(serverSource, /async function serveFile\(/);
  assert.doesNotMatch(serverSource, /async function servePublicFile\(/);
  assert.doesNotMatch(serverSource, /async function serveStatic\(/);

  assert.equal(typeof sendJson, 'function');
  assert.equal(typeof readBody, 'function');
  assert.equal(typeof openSse, 'function');
  assert.equal(typeof sendSseEvent, 'function');
  assert.equal(typeof serveStatic, 'function');
});
