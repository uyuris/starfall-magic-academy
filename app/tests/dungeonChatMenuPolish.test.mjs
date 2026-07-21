import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

function ruleBlock(css, selector) {
  // Flat rules only (no nested braces): capture from the selector to its first closing brace.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\}`))?.[0] ?? '';
}

test('chat bubble pop-in fades only, with no transform, so it cannot jerk against scroll-to-bottom', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const keyframes = css.match(/@keyframes bubble-pop-in[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(keyframes, 'the bubble-pop-in keyframes must exist (shared by academy + dungeon chat)');
  // The downward jerk came from a translateY rise + an overshoot settle; the bubble now fades only,
  // with no transform of any kind, so there is no vertical motion to jerk.
  assert.doesNotMatch(keyframes, /transform|translate/, 'pop-in must animate opacity only — no transform, so the bubble cannot jerk vertically');
  assert.match(keyframes, /0%\s*\{\s*opacity:\s*0;\s*\}/, 'pop-in should start fully transparent');
  assert.match(keyframes, /100%\s*\{\s*opacity:\s*1;\s*\}/, 'pop-in should end fully opaque');
  // The shared pop-in driver stays intact so academy + dungeon chat still animate through the variable.
  assert.match(css, /\.chat-message\.pop-in\s*\{[\s\S]*animation:\s*bubble-pop-in\s+var\(--bubble-pop-in-duration\)/, 'the shared pop-in class must keep driving the configurable animation');
});

test('dungeon menu + close buttons share the chip/button token contract with a pill radius (no float)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');

  // Menu button: pill radius matches the HP/turn HUD chips (also pill) so it no longer floats as a boxy panel.
  const menu = ruleBlock(css, '.dungeon-hud-button');
  assert.match(menu, /border-radius:\s*var\(--radius-pill\)/, 'menu button should use the pill radius token so it matches the HUD chip family');
  assert.match(menu, /border:\s*1px solid var\(--dungeon-line\)/, 'menu button should use the dungeon amber hairline border token');
  assert.match(menu, /background:\s*var\(--dungeon-chip\)/, 'menu button should use the dungeon obsidian chip surface token');
  assert.match(menu, /color:\s*var\(--dungeon-ink-strong\)/, 'menu button should use the dungeon ivory ink token');
  assert.doesNotMatch(menu, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'menu button should introduce no literal rgba/hex colors');

  // Close button: pill radius on the fixed 34x34 box makes it a clean circle in the same family.
  const close = ruleBlock(css, '.dungeon-icon-button');
  assert.match(close, /border-radius:\s*var\(--radius-pill\)/, 'close button should use the pill radius token (circular on its 34x34 box)');
  assert.match(close, /border:\s*1px solid var\(--dungeon-line\)/, 'close button should share the dungeon amber hairline border token');
  assert.match(close, /background:\s*var\(--dungeon-chip\)/, 'close button should share the dungeon obsidian chip surface token');
  assert.match(close, /color:\s*var\(--dungeon-ink-strong\)/, 'close button should use the dungeon ivory ink token');
  assert.doesNotMatch(close, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'close button should introduce no literal rgba/hex colors');
});
