import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the dungeon HUD tags the turn chip so its value width can be fixed', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // renderDungeonHud builds the turn chip and tags it with the --turn modifier; the CSS hangs the
  // fixed-occupancy-width rule off that modifier so only the turn value is stabilized (not the 実践 chip).
  assert.match(
    js,
    /function renderDungeonHud\(view\)[\s\S]*const turnChip = dungeonChipEl\('ターン', String\(view\.turn\)\);[\s\S]*turnChip\.classList\.add\('dn-hud-chip--turn'\);[\s\S]*node\.append\(turnChip\);/,
    'the turn chip carries the dn-hud-chip--turn modifier',
  );
});

test('the turn value takes a FIXED occupancy width so party vitals never shift across the whole turn range', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const rule = css.match(/\.dn-hud-chip--turn strong \{[\s\S]*?\}/)?.[0] ?? '';
  assert.ok(rule, 'the .dn-hud-chip--turn strong rule exists');
  // inline-block + a FIXED width is what makes the chip's row contribution independent of the digit count
  // for the entire turn range, so the HP/MP party cards to its right keep a constant horizontal start.
  assert.match(rule, /display:\s*inline-block/, 'the turn value is inline-block so a width applies');
  assert.match(rule, /(^|[^-])width:\s*4ch/, 'the turn value takes a fixed occupancy width (4 digits / 1..9999)');
  // It must be a fixed width, NOT min-width: min-width would let a 4+ digit turn grow the box and push the
  // party sideways again (the very regression this fixes). A fixed width keeps the box constant and lets an
  // over-range turn overflow without moving siblings.
  assert.doesNotMatch(rule, /min-width/, 'the turn slot is fixed, not a min-width that grows past the reservation');
  // tabular-nums keeps every digit a uniform advance, so the slot does not jitter between values of equal
  // length (e.g. 111 vs 999) in the proportional UI font.
  assert.match(rule, /font-variant-numeric:\s*tabular-nums/, 'digits share a uniform advance');
});

test('the turn-width rule preserves the height contract and token/fallback discipline', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const rule = css.match(/\.dn-hud-chip--turn strong \{[\s\S]*?\}/)?.[0] ?? '';
  // It only fixes the horizontal occupancy: it must not pin a height or add a line, which would
  // reintroduce the HUD-header reflow the prior fixed-height work removed.
  assert.doesNotMatch(rule, /(^|[^-])height:/, 'the turn-width rule sets no height (height-stable contract stays intact)');
  assert.doesNotMatch(rule, /white-space|line-height/, 'the rule adds no line-affecting property');
  // Token discipline: no literal rgba/hex colors, and no var() default-value fallback.
  assert.doesNotMatch(rule, /rgba\(|#[0-9a-fA-F]{3,6}\b/, 'no literal rgba/hex color introduced');
  assert.doesNotMatch(rule, /var\(--[^)]*,/, 'no var() default-value fallback introduced');
});
