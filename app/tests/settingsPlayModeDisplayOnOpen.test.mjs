import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';

// The settings screen has more than one entry point (the persistent top-bar 設定 tab and the
// title/academy-map 設定 button). Each entry inlining its own "open + reflect saved settings" wiring once
// caused a section to be reflected from one entry but not the other, so every entry routes through a single
// openSettingsScreen() opener that reflects all settings sections. These source-text checks guard that
// structural invariant (jsdom cannot render the live shell — see .agents/docs/reference/ref-camera.md — so
// the real two-entry visual is a manual check noted in the report).

function functionBody(js, name) {
  return js.match(new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

test('a single openSettingsScreen opener reflects every settings section', async () => {
  const js = await readFile(path.join(runtimePublicReferenceRoot, 'app.js'), 'utf8');

  const opener = functionBody(js, 'openSettingsScreen');
  assert.notEqual(opener, '', 'app.js should define a single openSettingsScreen() opener');
  assert.match(opener, /showScreen\('settings'\)/, 'opener should show the settings screen');
  assert.match(opener, /loadLmStudioSettings\(\)/, 'opener should reflect the LM Studio section');
  assert.match(opener, /loadConversationPopupSettings\(\)/, 'opener should reflect the conversation popup section');
  assert.match(opener, /renderRoutingFinalizePanel\(\)/, 'opener should render the conversation post-processing (finalize) recovery panel from runtime state');
  // Routing is the official mode: there is no play-mode section to reflect, so the opener must not load one.
  assert.doesNotMatch(opener, /loadPlayModeSettings/, 'the opener must not load a removed play-mode settings section');
});

test('both settings entry points route through the shared opener', async () => {
  const js = await readFile(path.join(runtimePublicReferenceRoot, 'app.js'), 'utf8');

  // Top-bar [data-screen="settings"] tab: must delegate to the opener, not inline a partial load.
  assert.match(
    js,
    /if \(tab\.dataset\.screen === 'settings'\) \{\s*openSettingsScreen\(\);\s*return;\s*\}/,
    'top-bar settings tab should open the settings screen through openSettingsScreen()'
  );

  // Title / academy-map 設定 button.
  assert.match(
    js,
    /querySelector\('#open-settings-screen'\)\s*\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*openSettingsScreen\(\);\s*\}\)/,
    'title settings button should open the settings screen through openSettingsScreen()'
  );
});

test('the removed play-mode settings section leaves no trace in the browser script', async () => {
  const js = await readFile(path.join(runtimePublicReferenceRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /loadPlayModeSettings|savePlayModeSettings|renderRoutingPersonaVariants|renderActiveSlotPersona/, 'the play-mode settings functions are removed');
  assert.doesNotMatch(js, /\/api\/settings\/play-mode/, 'the browser script no longer reads or writes the play-mode settings sidecar');
});
