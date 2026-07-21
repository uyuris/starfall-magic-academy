import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the per-element effect sprites exist for all six elements (bolt + impact)', async () => {
  const effectsDir = path.join(projectRoot, 'assets/canonical/dungeon/effects');
  for (const element of ['light', 'dark', 'fire', 'water', 'earth', 'wind']) {
    for (const part of ['bolt', 'impact']) {
      const file = path.join(effectsDir, `${element}_${part}.png`);
      const buf = await readFile(file);
      assert.ok(buf.length > 0, `${element}_${part}.png exists and is non-empty`);
    }
  }
});

test('the effect asset URL is built from the fixed element set and a .png path, failing fast on unknowns', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(js, /const DUNGEON_EFFECT_ELEMENTS = \['light', 'dark', 'fire', 'water', 'earth', 'wind'\];/, 'the six elements are a fixed set');
  // .png-only canonical path, no extension/jpg fallback.
  assert.match(js, /function dungeonEffectAssetUrl\(element, part\)[\s\S]*return `\/canonical\/dungeon\/effects\/\$\{element\}_\$\{part\}\.png`;/, 'the URL is /canonical/dungeon/effects/<element>_<part>.png');
  // Unknown element fails fast — no default/fallback sprite.
  assert.match(js, /function dungeonEffectAssetUrl\(element, part\)\s*\{[\s\S]*if \(!DUNGEON_EFFECT_ELEMENTS\.includes\(element\)\) throw new Error/, 'an unknown element throws (no silent fallback)');
  assert.doesNotMatch(js, /dungeonEffectAssetUrl[\s\S]{0,200}\?\?/, 'the asset URL builder uses no ?? fallback');
});

test('element events use bolt + impact assets; melee stays a neutral non-asset strike', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const assetFn = js.match(/function spawnDungeonAssetEffect\([\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(assetFn, 'spawnDungeonAssetEffect exists');
  // The bolt sprite travels from the actor; the impact sprite bursts on the target on a hit.
  assert.match(assetFn, /dungeonEffectAssetUrl\(event\.element, 'bolt'\)/, 'the projectile uses the element bolt asset');
  assert.match(assetFn, /if \(!event\.hit\) return;[\s\S]*dungeonEffectAssetUrl\(event\.element, 'impact'\)/, 'a hit uses the element impact asset; a miss lands none');
  // The asset path never reaches for a melee/element color or a default sprite.
  const meleeFn = js.match(/function spawnDungeonMeleeEffect\([\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(meleeFn, 'spawnDungeonMeleeEffect exists');
  assert.doesNotMatch(meleeFn, /dungeonEffectAssetUrl/, 'the melee strike pulls no element asset');
  assert.match(meleeFn, /dn-effect dn-effect--melee/, 'melee keeps the neutral CSS strike');
});

test('the asset bolt is suppressed under reduced motion, the impact stays brief', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The moving bolt is hidden under reduced motion (alongside the melee projectile).
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.dn-effect, \.dn-effect-bolt \{ display: none; \}/, 'the asset bolt is suppressed under reduced motion');
  // Asset sprites are sized from JS-set custom properties with no var() default fallback.
  const bolt = css.match(/\.dn-effect-bolt \{[\s\S]*?\}/)?.[0] ?? '';
  const burst = css.match(/\.dn-effect-burst \{[\s\S]*?\}/)?.[0] ?? '';
  assert.match(bolt, /width: var\(--dn-effect-size\);/, 'the bolt size comes from --dn-effect-size');
  assert.match(burst, /width: var\(--dn-impact-size\);/, 'the burst size comes from --dn-impact-size');
  assert.doesNotMatch(bolt + burst, /var\(--[^)]*,/, 'no var() default-value fallback on the asset sprites');

  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const assetFn = js.match(/function spawnDungeonAssetEffect\([\s\S]*?\n}/)?.[0] ?? '';
  // Under reduced motion the bolt does not travel (goes straight to the impact), and the impact is a
  // brief static flash rather than a scale burst.
  assert.match(assetFn, /if \(reduce\) \{ window\.setTimeout\(landImpact, 0\); return; \}/, 'reduced motion skips the bolt travel');
  assert.match(assetFn, /if \(reduce\) \{ window\.setTimeout\(\(\) => impact\.remove\(\), 200\); return; \}/, 'reduced motion shows only a brief static impact');
});
