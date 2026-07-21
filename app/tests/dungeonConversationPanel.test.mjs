import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('conversation panel is widened; the fixed chat header (companion icon / name / bars) is gone', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  assert.match(css, /\.dungeon-side \{[\s\S]*flex: 5/, 'the conversation panel rail is widened (the right rail takes the row 5-share)');
  // The fixed chat header is removed, so its companion icon / name / stats CSS leaves no orphan rules.
  assert.doesNotMatch(css, /\.dungeon-chat-companion\b|\.dungeon-chat-head\b|\.dungeon-chat-stats\b|\.dungeon-chat-heading\b/, 'the removed chat header leaves no orphan CSS rule');
  assert.doesNotMatch(css, /\.dungeon-chat-encounter\b/, 'the removed encounter sub-label leaves no orphan CSS rule');
});

test('the per-message dungeon chat avatar is enlarged, scoped to the dungeon (academy chat unchanged)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The per-message face (the avatar left of each bubble) is enlarged only under .dungeon-chat-log,
  // so the dungeon companion chat gets a bigger avatar.
  assert.match(css, /\.dungeon-chat-log \.message-face \{[\s\S]*width: 72px;[\s\S]*height: 72px;[\s\S]*flex: 0 0 72px[\s\S]*\}/, 'the dungeon per-message avatar is enlarged to 72px');
  // Narration bubbles keep their left edge aligned with the (now larger) avatar column.
  assert.match(css, /\.dungeon-chat-log \.narration-message \.message-bubble \{ margin-left: calc\(72px \+ 8px\); \}/, 'narration indent tracks the enlarged dungeon avatar');
  // Isolation: the enlargement rides the .dungeon-chat-log scope, and the shared base .message-face
  // (which the academy conversation stream inherits) is untouched at 129px — so the academy chat
  // avatar is not changed by this task.
  assert.match(css, /\.message-face \{[\s\S]*width: 129px;[\s\S]*height: 129px;[\s\S]*flex: 0 0 129px[\s\S]*\}/, 'the shared base message face (academy) stays 129px — dungeon override is scoped, not global');
});

test('the send button reads 送信', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  assert.match(html, /id="dungeon-talk-send"[^>]*>送信<\/button>/, 'the send button says 送信');
});

// The companion detail is now the unified actor-detail shell opened from the HUD party-card name (the old
// per-kind character-detail dialog + homunculus popup are removed). Its contract lives in
// dungeonDetailShell.test.mjs; here we only assert the old dungeon-owned dialog/popup wiring is gone.
test('the old per-kind companion detail dialog / homunculus popup wiring is removed', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /dungeon-character-detail-dialog|dungeon-homunculus-detail/, 'the old detail dialog / homunculus popup DOM is gone');
  assert.doesNotMatch(js, /openDungeonHomunculusDetail|closeDungeonHomunculusDetail|dungeon-character-detail-dialog|dungeon-homunculus-detail/, 'the old detail dialog / homunculus popup JS is gone');
});
