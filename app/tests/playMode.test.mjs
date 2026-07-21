import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PLAY_MODE,
  PLAY_MODES,
  ROUTING_PERSONA_VARIANTS,
  chooseRandomRoutingPersonaVariant,
  newGameActivePlayMode,
  normalizePlayModeSettings,
  resolveActivePlayMode,
  resolvePostContentScreen,
  validatePlayModeUpdate,
  validateRoutingPersonaVariant
} from '../src/playMode.mjs';

test('play mode constants expose the closed set used by settings API callers', () => {
  assert.equal(DEFAULT_PLAY_MODE, 'loop');
  assert.deepEqual(PLAY_MODES, ['loop', 'routing']);
  assert.equal(Object.isFrozen(PLAY_MODES), true);
});

test('routing persona variant constants expose the closed set used by routing callers', () => {
  assert.deepEqual(ROUTING_PERSONA_VARIANTS, ['fallen_star', 'bureau_apprentice', 'dethroned_constellation', 'scale_arbiter', 'pool_cat', 'far_side_sister', 'eclipse_shadow', 'hourglass_grain', 'star_egg_keeper', 'stardust_sweeper']);
  assert.equal(Object.isFrozen(ROUTING_PERSONA_VARIANTS), true);
  assert.equal(validateRoutingPersonaVariant('fallen_star'), 'fallen_star');
  assert.throws(() => validateRoutingPersonaVariant(' fallen_star '), /routing persona variant/);
  assert.throws(() => validateRoutingPersonaVariant('banana'), /routing persona variant/);
});

test('play mode normalization validates mode + variant shape on read and tolerates an out-of-set variant', () => {
  assert.deepEqual(normalizePlayModeSettings({ mode: 'loop' }), { mode: 'loop' });
  assert.deepEqual(normalizePlayModeSettings({ mode: 'loop', routing_persona_variant: 'fallen_star' }), { mode: 'loop', routing_persona_variant: 'fallen_star' });
  assert.deepEqual(normalizePlayModeSettings({ mode: 'routing', routing_persona_variant: 'fallen_star' }), { mode: 'routing', routing_persona_variant: 'fallen_star' });
  // Read tolerates a persisted variant outside the current closed set (e.g. left by an install predating a
  // closed-set replacement): it is carried through as-is, NOT closed-set validated / defaulted / mapped.
  // Closed-set membership is enforced on write (validatePlayModeUpdate) and at the point of use.
  assert.deepEqual(normalizePlayModeSettings({ mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }), { mode: 'routing', routing_persona_variant: 'legacy_removed_variant' });
  assert.throws(() => normalizePlayModeSettings({ mode: ' routing ' }), /mode/);
  // Routing with no variant, or a non-string variant, is malformed (shape violation) and still fail-fasts.
  assert.throws(() => normalizePlayModeSettings({ mode: 'routing' }), /routing persona variant/);
  assert.throws(() => normalizePlayModeSettings({ mode: 'routing', routing_persona_variant: '' }), /routing persona variant/);
  assert.throws(() => normalizePlayModeSettings({ mode: 'routing', routing_persona_variant: 42 }), /routing persona variant/);
  assert.throws(() => normalizePlayModeSettings({ mode: 'banana' }), /mode/);
  assert.throws(() => normalizePlayModeSettings({}), /mode/);
});

test('play mode PATCH validation accepts only explicit closed-set updates', () => {
  assert.deepEqual(validatePlayModeUpdate({ mode: 'loop' }), { mode: 'loop' });
  assert.deepEqual(validatePlayModeUpdate({ mode: 'loop', routing_persona_variant: 'fallen_star' }), { mode: 'loop', routing_persona_variant: 'fallen_star' });
  assert.deepEqual(validatePlayModeUpdate({ mode: 'routing', routing_persona_variant: 'fallen_star' }), { mode: 'routing', routing_persona_variant: 'fallen_star' });
  assert.throws(() => validatePlayModeUpdate({ mode: 'routing\n' }), /mode/);
  assert.throws(() => validatePlayModeUpdate({ mode: 'routing' }), /routing persona variant/);
  assert.throws(() => validatePlayModeUpdate({ mode: 'routing', routing_persona_variant: 'fallen_star\n' }), /routing persona variant/);
  assert.throws(() => validatePlayModeUpdate({ mode: 'banana' }), /mode/);
  assert.throws(() => validatePlayModeUpdate({}), /mode/);
});

test('resolveActivePlayMode defaults only missing sidecar to loop and fails fast on stored corruption', async () => {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-active-play-mode-'));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');

  assert.deepEqual(await resolveActivePlayMode(settingsPath), { mode: 'loop' });
  await assert.rejects(fs.stat(settingsPath), { code: 'ENOENT' }, 'missing sidecar fallback must not materialize storage');

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'hourglass_grain' }, null, 2)}\n`, 'utf8');
  assert.deepEqual(await resolveActivePlayMode(settingsPath), { mode: 'routing', routing_persona_variant: 'hourglass_grain' });

  // A persisted variant outside the current closed set (pre-replacement install) resolves without
  // throwing — the sidecar read stays usable so the server boots and the settings surface is reachable
  // for re-selection; the stale variant fails fast only when a routing operation actually uses it.
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }, null, 2)}\n`, 'utf8');
  assert.deepEqual(await resolveActivePlayMode(settingsPath), { mode: 'routing', routing_persona_variant: 'legacy_removed_variant' });

  await fs.writeFile(settingsPath, '{not-json', 'utf8');
  await assert.rejects(
    () => resolveActivePlayMode(settingsPath),
    (error) => error?.statusCode === 500 && /corrupt/i.test(error.message)
  );

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'banana' })}\n`, 'utf8');
  await assert.rejects(
    () => resolveActivePlayMode(settingsPath),
    (error) => error?.statusCode === 500 && /invalid/i.test(error.message)
  );

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing' })}\n`, 'utf8');
  await assert.rejects(
    () => resolveActivePlayMode(settingsPath),
    (error) => error?.statusCode === 500 && /routing persona variant/.test(error.message)
  );
});

test('chooseRandomRoutingPersonaVariant maps the injected random uniformly onto the closed set and clamps the edge', () => {
  // Each index bucket [i/N, (i+1)/N) maps to variant i; injecting a mid-bucket value selects that variant.
  for (let index = 0; index < ROUTING_PERSONA_VARIANTS.length; index += 1) {
    const mid = (index + 0.5) / ROUTING_PERSONA_VARIANTS.length;
    assert.equal(chooseRandomRoutingPersonaVariant(() => mid), ROUTING_PERSONA_VARIANTS[index]);
  }
  // Boundaries: 0 → first variant; a value at/over 1 (out of Math.random contract) clamps to the last.
  assert.equal(chooseRandomRoutingPersonaVariant(() => 0), ROUTING_PERSONA_VARIANTS[0]);
  assert.equal(chooseRandomRoutingPersonaVariant(() => 0.999999), ROUTING_PERSONA_VARIANTS[ROUTING_PERSONA_VARIANTS.length - 1]);
  assert.equal(chooseRandomRoutingPersonaVariant(() => 1), ROUTING_PERSONA_VARIANTS[ROUTING_PERSONA_VARIANTS.length - 1]);
  // Every variant is reachable and no other value is ever produced (uniform coverage over the closed set).
  const produced = new Set();
  for (let n = 0; n < 10000; n += 1) produced.add(chooseRandomRoutingPersonaVariant(() => n / 10000));
  assert.deepEqual([...produced].sort(), [...ROUTING_PERSONA_VARIANTS].sort());
});

test('newGameActivePlayMode is always routing with a random closed-set persona variant (never loop, never sidecar-derived)', () => {
  assert.deepEqual(newGameActivePlayMode(() => 0), { mode: 'routing', routing_persona_variant: ROUTING_PERSONA_VARIANTS[0] });
  const picked = newGameActivePlayMode(() => 0.42);
  assert.equal(picked.mode, 'routing');
  assert.ok(ROUTING_PERSONA_VARIANTS.includes(picked.routing_persona_variant));
});

test('resolvePostContentScreen keeps the loop caller screen and routes routing mode to the hub screen', () => {
  assert.equal(resolvePostContentScreen({ mode: 'loop', loopScreen: 'academy-room' }), 'academy-room');
  assert.equal(resolvePostContentScreen({ mode: 'loop', loopScreen: 'academy-map' }), 'academy-map');
  assert.equal(resolvePostContentScreen({ mode: 'routing', loopScreen: 'academy-room' }), 'interaction');
  assert.throws(() => resolvePostContentScreen({ mode: 'banana', loopScreen: 'academy-room' }), /mode/);
  assert.throws(() => resolvePostContentScreen({ mode: 'loop', loopScreen: '' }), /loopScreen/);
});
