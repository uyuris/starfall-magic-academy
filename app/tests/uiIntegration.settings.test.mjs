import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;

// The settings screen adds a general "セーブデータ修正" category alongside the existing lmstudio /
// conversation-popup / conversation-finalize / audio categories, and the first entry inside it is the
// unconsumed-routing-conversation-pointer migration. The button posts to the same-prefixed backend
// endpoint and reports the result inline (success text or error tone). This test file pins the source
// shape: nav tab exists, panel exists, entry list renders the migration, the button is wired to the JS
// handler, the JS handler posts to the sanctioned endpoint under the shared single-flight guard.

test('settings screen exposes a セーブデータ修正 category alongside the existing categories', async () => {
  const html = await readUiSource(path.join(root, 'index.html'), 'utf8');

  // Nav tab: the save-data-repair tab sits at the tail of the four pre-existing tabs, and none of the
  // existing tabs are renamed or lose their attributes (structural neighbor pin).
  assert.match(
    html,
    /data-settings-category="audio"[\s\S]*?>サウンド<\/button>[\s\S]*?<button id="settings-category-save-data-repair"[^>]*data-settings-category="save-data-repair"[^>]*aria-controls="settings-panel-save-data-repair"[^>]*aria-pressed="false"[^>]*>セーブデータ修正<\/button>/,
    'save-data-repair category tab must sit at the tail of the settings-category-nav, after サウンド'
  );

  // Panel: hidden by default (only the active category's panel is visible), a labelled heading, and an
  // inline status paragraph that reassures 冪等 (何度実行しても副作用ありません).
  assert.match(
    html,
    /<section id="settings-panel-save-data-repair"[^>]*class="settings-card settings-category-panel"[^>]*data-settings-category="save-data-repair"[^>]*aria-labelledby="save-data-repair-settings-title"[^>]*hidden>/,
    'save-data-repair panel section must be present with the shared settings-card / category-panel classes and default hidden'
  );
  assert.match(
    html,
    /<h3 id="save-data-repair-settings-title">[^<]*<\/h3>/,
    'save-data-repair panel must have a heading that the labelledby references'
  );
  assert.match(
    html,
    /id="save-data-repair-settings-status"[^>]*aria-live="polite"[^>]*>[^<]*何度実行しても副作用ありません[^<]*</,
    'save-data-repair panel must expose an aria-live status line reassuring 冪等 execution'
  );
});

test('settings screen renders the 案内人注入寿命 migration as the first (currently only) セーブデータ修正 entry', async () => {
  const html = await readUiSource(path.join(root, 'index.html'), 'utf8');

  assert.match(
    html,
    /<ul id="save-data-repair-entries"[^>]*class="save-data-repair-entries"[^>]*>\s*<li[^>]*data-save-data-repair-entry="unconsumed-routing-conversation-pointer"/,
    'the save-data-repair entries list must start with the unconsumed-routing-conversation-pointer migration'
  );
  assert.match(
    html,
    /<h4 class="save-data-repair-entry-title">案内人注入寿命の設定を追加<\/h4>/,
    'the entry title must read 案内人注入寿命の設定を追加'
  );
  assert.match(
    html,
    /<p class="save-data-repair-entry-description">案内人が hub 会話で参照する記憶を 1 回消費で忘れる形にするために、既存セーブデータへ設定を追加します。何度実行しても副作用ありません。<\/p>/,
    'the entry description must explain the intent and 冪等'
  );
  assert.match(
    html,
    /<button id="save-data-repair-unconsumed-routing-conversation-pointer-button" type="button" class="academy-map-action-button">実行する<\/button>/,
    'the entry must expose the 実行する button with the sanctioned button id'
  );
  assert.match(
    html,
    /<p id="save-data-repair-unconsumed-routing-conversation-pointer-result" class="save-data-repair-entry-result" aria-live="polite">/,
    'the entry must expose an aria-live result paragraph for post-run feedback'
  );
});

test('settings JS wires the 実行する button to the sanctioned endpoint under a single-flight guard', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');

  // The category is registered in SETTINGS_CATEGORIES so the nav tab activates its panel and the
  // openSettingsScreen resetter clears any prior run's inline text on each open.
  assert.match(
    js,
    /const SETTINGS_CATEGORIES = \[[^\]]*'save-data-repair'\s*\]/,
    'save-data-repair must be a registered settings category'
  );
  assert.match(
    js,
    /function openSettingsScreen\([\s\S]*?resetSaveDataRepairResults\(\)/,
    'openSettingsScreen must reset the save-data-repair inline results on each open'
  );

  // Endpoint pin: the JS uses the same path prefix the backend registers, so a rename on either side is
  // caught by this test (the source-regex is the shared contract).
  assert.match(
    js,
    /const SAVE_DATA_REPAIR_UNCONSUMED_POINTER_ENDPOINT = '\/api\/settings\/save-data-repair\/unconsumed-routing-conversation-pointer'/,
    'JS endpoint constant must match the backend contract path'
  );

  // Single-flight guard: the button is disabled at the top of the handler and re-enabled in a finally
  // block; a second entry into runSaveDataRepairMigration while the button is already disabled returns
  // immediately (belt-and-braces alongside the backend 409).
  assert.match(
    js,
    /async function runSaveDataRepairMigration\(entryKey, endpoint\)\s*\{[\s\S]*?if \(!button \|\| button\.disabled\) return;[\s\S]*?button\.disabled = true;[\s\S]*?} finally \{[\s\S]*?button\.disabled = false;[\s\S]*?\}\s*\}/,
    'runSaveDataRepairMigration must implement the disable-on-entry / re-enable-in-finally single-flight guard'
  );

  // Success formatter must surface added / skipped counts (no silent 0/0 collapse), and the click
  // listener must be bound to the sanctioned button id.
  assert.match(
    js,
    /function formatSaveDataRepairSuccessMessage\(result\)[\s\S]*?added[\s\S]*?skipped_already_present[\s\S]*?slot に設定を追加しました[\s\S]*?既に持っていた/,
    'success message must render added and skipped_already_present counts'
  );
  assert.match(
    js,
    /document\.querySelector\('#save-data-repair-unconsumed-routing-conversation-pointer-button'\)[\s\S]*?addEventListener\('click', \(\) => \{[\s\S]*?runSaveDataRepairMigration\(\s*'unconsumed-routing-conversation-pointer',[\s\S]*?SAVE_DATA_REPAIR_UNCONSUMED_POINTER_ENDPOINT/,
    'the 実行する button must be wired to runSaveDataRepairMigration with the pointer entry key + endpoint'
  );
});

test('save-data-repair CSS uses only the settings-scoped --meta-* token layer (no literal color pins)', async () => {
  const css = await readUiSource(path.join(root, 'style.css'), 'utf8');

  // Extract the block that defines the save-data-repair entries. The rules must not include hex or rgb
  // literals; every color / border reference must go through var(--meta-*) or an existing project token.
  const start = css.indexOf('.save-data-repair-entries');
  assert.notEqual(start, -1, 'save-data-repair CSS block must exist');
  const end = css.indexOf('/* ── セーブデータ選択画面', start);
  assert.notEqual(end, -1, 'save-data-repair CSS block must be closed off by the following section');
  const block = css.slice(start, end);

  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'save-data-repair CSS must not pin literal hex colors');
  assert.doesNotMatch(block, /\brgba?\(\s*\d/, 'save-data-repair CSS must not pin literal rgb()/rgba() color values');
  assert.match(block, /var\(--meta-line\)/, 'save-data-repair CSS must consume the --meta-line token');
  assert.match(block, /var\(--meta-silver-strong\)/, 'save-data-repair CSS must consume the --meta-silver-strong token');
  assert.match(block, /var\(--meta-panel-strong\)/, 'save-data-repair CSS must consume the --meta-panel-strong token');
});
