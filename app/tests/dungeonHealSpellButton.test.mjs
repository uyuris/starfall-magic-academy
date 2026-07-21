import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the heal button sits on the shared action row directly below the attack-spell group', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  // Order inside the dock-main column: attack spells -> action row (回復・貫通・回避) -> controls hint, so the
  // heal button renders directly under the element buttons, sharing one row with the composite spells.
  assert.match(
    html,
    /id="dungeon-spells"[\s\S]*id="dungeon-actions"[\s\S]*dungeon-controls-hint/,
    'a #dungeon-actions container sits between #dungeon-spells and the controls hint',
  );
});

test('the heal button is built from view.healing_spell and dispatches heal_spell on the shared action path', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const fn = js.match(/function renderDungeonDock\(view\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(fn, 'renderDungeonDock exists');
  // The heal slot is populated after the castable-element loop (so it is below the attack spells in render
  // order too), on the shared action row, and entirely from view.healing_spell.
  assert.match(fn, /view\.castable_elements[\s\S]*#dungeon-actions[\s\S]*view\.healing_spell/, 'heal slot rendered after the cast loop from view.healing_spell');
  // Label/enabled come straight from the contract fields — no front-end recompute of heal amount or MP.
  assert.match(fn, /MP\$\{mp_cost\}/, 'the visible MP label uses the contract mp_cost');
  assert.match(fn, /自己回復 \+\$\{heal_amount\}/, 'the title shows the contract heal_amount');
  assert.match(fn, /healButton\.disabled = !can_use/, 'enabled state is driven by the contract can_use (no recompute)');
  // Click dispatches the heal via the same dungeonDo path the attack casts use, using the contract action_type.
  assert.match(fn, /dungeonDo\(\{ type: action_type \}\)\.catch\(reportError\)/, 'click dispatches { type: action_type } through dungeonDo');
});

test('a missing healing_spell contract fails fast (no silent fallback)', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const fn = js.match(/function renderDungeonDock\(view\)[\s\S]*?\n}/)?.[0] ?? '';
  // Absent field or malformed contract throws rather than dropping the button or defaulting values.
  assert.match(fn, /if \(!healing\) throw new Error\('dungeon view is missing healing_spell'\)/, 'missing healing_spell throws');
  assert.match(fn, /action_type !== 'heal_spell'[\s\S]*throw new Error\('dungeon healing_spell is missing required fields'\)/, 'missing/malformed required fields throw');
  // The full contract shape is validated, including recoverable_hp even though the button does not display
  // it — a malformed contract missing that field must still fail fast.
  for (const field of ['mp_cost', 'heal_amount', 'recoverable_hp']) {
    assert.match(fn, new RegExp(`typeof ${field} !== 'number'`), `${field} is validated as a required number`);
  }
  assert.match(fn, /typeof can_use !== 'boolean'/, 'can_use is validated as a required boolean');
  // No silent fallback: healing_spell is never coalesced to a default object/value.
  assert.doesNotMatch(fn, /healing_spell\s*\?\?/, 'healing_spell is not given a ?? fallback');
  assert.doesNotMatch(fn, /healing_spell\s*\|\|/, 'healing_spell is not given a || fallback');
});

test('the heal button styling reuses the spell pill, takes the dungeon amber accent token, and adds no literal colors', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  assert.match(css, /\.dungeon-actions \{[\s\S]*display:\s*flex[\s\S]*flex-wrap:\s*wrap/, 'the action row is a wrapping flex container so the three pills stay inside the dock at narrow widths');
  const accent = css.match(/\.dungeon-spell-heal \{[\s\S]*?\}/)?.[0] ?? '';
  assert.ok(accent, 'the .dungeon-spell-heal rule exists');
  assert.match(accent, /color:\s*var\(--dungeon-amber\)/, 'the heal accent uses the dungeon amber token (no literal color)');
  assert.doesNotMatch(accent, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'no literal rgba/hex color introduced');
  assert.doesNotMatch(accent, /var\(--[^)]*,/, 'no var() default-value fallback introduced');
});
