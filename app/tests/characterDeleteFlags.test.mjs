import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import { readCharacterDeleteFlags, toggleCharacterDeleteFlag } from '../src/server/deleteFlagsStore.mjs';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { isolatedServerOptions } from './helpers.mjs';

async function contentRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-delete-flags-'));
  await fs.mkdir(path.join(root, 'content', 'characters'), { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function flagsFilePath(root) {
  return path.join(root, 'content', 'characters', 'delete-flags.json');
}

async function withServer(t, root) {
  const server = createServer(await isolatedServerOptions(t, { root, activeRoot: root }, 'magic-adv-delete-flags-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('delete flags store: a missing file is initialized by creating an empty flags file', async (t) => {
  const root = await contentRoot(t);
  assert.deepEqual(await readCharacterDeleteFlags({ root }), { flagged: [] });
  // First-run initialization creates the persisted file so Phase 2 always has it.
  const onDisk = JSON.parse(await fs.readFile(flagsFilePath(root), 'utf8'));
  assert.deepEqual(onDisk, { flagged: [] });
});

test('delete flags store: toggle persists, restores on a fresh read, and removes on second toggle', async (t) => {
  const root = await contentRoot(t);

  const first = await toggleCharacterDeleteFlag({ root, characterId: 'character_057' });
  assert.equal(first.flagged_now, true);
  assert.deepEqual(first.flagged, ['character_057']);

  await toggleCharacterDeleteFlag({ root, characterId: 'character_009' });

  // Fresh read (re-load / restart equivalent) restores both ids, sorted.
  assert.deepEqual(await readCharacterDeleteFlags({ root }), { flagged: ['character_009', 'character_057'] });

  // The on-disk shape is the minimal { flagged: [...] } structure.
  const onDisk = JSON.parse(await fs.readFile(flagsFilePath(root), 'utf8'));
  assert.deepEqual(onDisk, { flagged: ['character_009', 'character_057'] });

  const off = await toggleCharacterDeleteFlag({ root, characterId: 'character_057' });
  assert.equal(off.flagged_now, false);
  assert.deepEqual(off.flagged, ['character_009']);
  assert.deepEqual(await readCharacterDeleteFlags({ root }), { flagged: ['character_009'] });
});

test('delete flags store: invalid character id fails fast', async (t) => {
  const root = await contentRoot(t);
  await assert.rejects(
    toggleCharacterDeleteFlag({ root, characterId: 'not-a-character' }),
    (error) => error.statusCode === 400 && /invalid character id/.test(error.message)
  );
});

test('delete flags store: a missing content root fails fast instead of reporting empty', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-delete-flags-bare-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  // No content/characters directory exists: reading must surface the error.
  await assert.rejects(readCharacterDeleteFlags({ root }), /ENOENT/);
});

test('delete flags API: GET, toggle persistence across a server restart, and removal', async (t) => {
  const root = await contentRoot(t);
  const base = await withServer(t, root);

  const initial = await (await fetch(`${base}/api/character-delete-flags`)).json();
  assert.deepEqual(initial, { flagged: [] });

  const toggled = await (await fetch(`${base}/api/character-delete-flags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_003' })
  })).json();
  assert.equal(toggled.flagged_now, true);
  assert.deepEqual(toggled.flagged, ['character_003']);

  const afterToggle = await (await fetch(`${base}/api/character-delete-flags`)).json();
  assert.deepEqual(afterToggle, { flagged: ['character_003'] });

  // Restart: a brand-new server instance on the same root must read the
  // persisted flag back from disk.
  const restartedBase = await withServer(t, root);
  const afterRestart = await (await fetch(`${restartedBase}/api/character-delete-flags`)).json();
  assert.deepEqual(afterRestart, { flagged: ['character_003'] });

  const cleared = await (await fetch(`${restartedBase}/api/character-delete-flags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_003' })
  })).json();
  assert.equal(cleared.flagged_now, false);
  assert.deepEqual(cleared.flagged, []);
});

test('delete flags API: invalid character id returns a clear 400 error', async (t) => {
  const root = await contentRoot(t);
  const base = await withServer(t, root);
  const response = await fetch(`${base}/api/character-delete-flags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: '' })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error_code, 'invalid_character_id');
  assert.match(payload.error, /invalid character id/);
});

test('delete flags API: a broken flags file surfaces an error instead of a silent success', async (t) => {
  const root = await contentRoot(t);
  // Make the flags path unreadable/unwritable by replacing it with a directory.
  await fs.mkdir(flagsFilePath(root), { recursive: true });
  const base = await withServer(t, root);

  const response = await fetch(`${base}/api/character-delete-flags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_003' })
  });
  assert.equal(response.ok, false);
  const payload = await response.json();
  assert.ok(payload.error, 'a broken flags file must produce a clear error payload');
  assert.equal(payload.flagged, undefined, 'a failed toggle must not return a success flag set');
});

test('delete flags UI: the field character selector renders a per-character flag toggle, badge, and visual state', async () => {
  const js = await fs.readFile(path.join(runtimePublicReferenceRoot, 'app.js'), 'utf8');
  const css = await fs.readFile(path.join(runtimePublicReferenceRoot, 'style.css'), 'utf8');

  // The flag UI is built inside renderCharacterSelector (the field/debug
  // character list), which is the only place that fills #character-selection-list.
  const renderBody = js.slice(js.indexOf('function renderCharacterSelector()'), js.indexOf('async function refreshCharacterDeleteFlags()'));
  assert.notEqual(renderBody, '', 'renderCharacterSelector should precede the delete-flag helpers');
  assert.match(renderBody, /character-option-cell/, 'each character should render inside a cell wrapper');
  assert.match(renderBody, /classList\.toggle\('is-delete-flagged', flagged\)/, 'flagged characters should get a visual-state class');
  assert.match(renderBody, /className = 'delete-flag-toggle'/, 'each character should render a delete-flag toggle button');
  assert.match(renderBody, /削除フラグを外す[\s\S]*削除フラグを付ける/, 'the toggle label should reflect flagged/unflagged state');
  assert.match(renderBody, /className = 'delete-flag-badge'/, 'a flagged character should render a 削除候補 badge');
  assert.match(renderBody, /event\.stopPropagation\(\)[\s\S]*toggleCharacterDeleteFlag\(character\.character_id\)/, 'the toggle must not also trigger character selection');
  assert.equal((js.match(/#character-selection-list/g) ?? []).length, 1, 'the delete-flag list should stay confined to the single field selector');

  // The toggle round-trips through the dedicated API and fails fast on a bad shape.
  assert.match(js, /postJson\('\/api\/character-delete-flags\/toggle', \{ character_id: characterId \}\)/, 'toggle should call the toggle endpoint');
  assert.match(js, /getJson\('\/api\/character-delete-flags'\)/, 'startup should load persisted flags');
  assert.match(js, /response is missing a "flagged" array/, 'an invalid flags response shape must fail fast, not silently default');
  assert.doesNotMatch(js, /result\.flagged \?\? \[\]/, 'delete-flag handling must not use a silent default fallback');

  // The flagged visual treatment exists in the stylesheet.
  assert.match(css, /\.delete-flag-toggle\s*\{/, 'the toggle button needs a style rule');
  assert.match(css, /\.delete-flag-badge\s*\{/, 'the 削除候補 badge needs a style rule');
  assert.match(css, /\.character-option-cell\.is-delete-flagged\s*\{/, 'flagged cells need a distinct visual treatment');
});
