import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildRoutingPersonaVisualSummary, routingPersonaVisualSetId } from '../src/routingPersonaVisual.mjs';

// A bare temp root resolves its canonical assets root to `<root>/assets/canonical`, so these tests can
// stage a fake (or absent) routing_lumi_<variant> visual set and assert the fail-fast contract without
// touching the real repo assets.
async function isolatedCanonicalRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-persona-visual-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function visualSetDir(root, visualSetId) {
  return path.join(root, 'assets', 'canonical', 'character_visual_sets', visualSetId);
}

async function writeFile(fullPath, content) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

test('routingPersonaVisualSetId maps each variant to its own routing_lumi_<variant> set (mechanical, no default)', () => {
  assert.equal(routingPersonaVisualSetId('fallen_star'), 'routing_lumi_fallen_star');
  assert.equal(routingPersonaVisualSetId('pool_cat'), 'routing_lumi_pool_cat');
  assert.equal(routingPersonaVisualSetId('stardust_sweeper'), 'routing_lumi_stardust_sweeper');
});

test('routingPersonaVisualSetId fail-fasts on an unknown variant (no silent default set)', () => {
  assert.throws(
    () => routingPersonaVisualSetId('routing_lumi'),
    /routing persona variant must be one of/,
    'an out-of-set variant must fail fast, not resolve to a default set'
  );
  assert.throws(() => routingPersonaVisualSetId(undefined), /routing persona variant must be one of/);
});

test('buildRoutingPersonaVisualSummary exposes the effective variant set summary from the real assets', async () => {
  const summary = await buildRoutingPersonaVisualSummary({ root: process.cwd(), personaVariant: 'fallen_star' });
  assert.deepEqual(summary, {
    character_id: 'lina',
    display_name: 'ルミ',
    visual_set_id: 'routing_lumi_fallen_star',
    face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
    selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
    standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg',
    available_expressions: ['neutral', 'joy', 'caring', 'confident', 'sadness', 'worried', 'anger', 'surprised', 'embarrassed', 'shy', 'serious', 'determined', 'panic', 'tired', 'sick', 'smug']
  });
});

test('buildRoutingPersonaVisualSummary follows the effective variant (a different variant resolves its own set)', async () => {
  const summary = await buildRoutingPersonaVisualSummary({ root: process.cwd(), personaVariant: 'dethroned_constellation' });
  assert.equal(summary.visual_set_id, 'routing_lumi_dethroned_constellation');
  assert.equal(summary.face_url, '/canonical/character_visual_sets/routing_lumi_dethroned_constellation/face_emotions/neutral.jpg');
  assert.equal(summary.standee_url, '/canonical/character_visual_sets/routing_lumi_dethroned_constellation/scene_standee/scene_standee_character_01.jpg');
});

test('buildRoutingPersonaVisualSummary fail-fasts on an unknown variant (no fallback set)', async () => {
  await assert.rejects(
    buildRoutingPersonaVisualSummary({ root: process.cwd(), personaVariant: 'routing_lumi' }),
    /routing persona variant must be one of/,
    'an unknown variant must fail fast before touching assets'
  );
});

test('buildRoutingPersonaVisualSummary fail-fasts when the neutral face asset is missing', async (t) => {
  const root = await isolatedCanonicalRoot(t);
  await assert.rejects(
    buildRoutingPersonaVisualSummary({ root, personaVariant: 'fallen_star' }),
    /missing routing persona neutral face asset: routing_lumi_fallen_star/,
    'a missing face asset must be a real error, not a blank/placeholder fallback'
  );
});

test('buildRoutingPersonaVisualSummary fail-fasts when the manifest is missing', async (t) => {
  const root = await isolatedCanonicalRoot(t);
  await writeFile(path.join(visualSetDir(root, 'routing_lumi_fallen_star'), 'face_emotions', 'neutral.jpg'), 'x');
  await assert.rejects(
    buildRoutingPersonaVisualSummary({ root, personaVariant: 'fallen_star' }),
    /missing visual set manifest: routing_lumi_fallen_star/,
    'a missing manifest must fail fast (no fallback to lina / character_001 / placeholder)'
  );
});

test('buildRoutingPersonaVisualSummary fail-fasts when the manifest standee asset is missing', async (t) => {
  const root = await isolatedCanonicalRoot(t);
  await writeFile(path.join(visualSetDir(root, 'routing_lumi_fallen_star'), 'face_emotions', 'neutral.jpg'), 'x');
  await writeFile(
    path.join(visualSetDir(root, 'routing_lumi_fallen_star'), 'manifest.json'),
    JSON.stringify({ visual_set_id: 'routing_lumi_fallen_star', scene_standee: { path: 'scene_standee/scene_standee_character_01.jpg' } })
  );
  await assert.rejects(
    buildRoutingPersonaVisualSummary({ root, personaVariant: 'fallen_star' }),
    /missing scene standee asset for routing_lumi_fallen_star/,
    'a manifest that references an absent standee must fail fast'
  );
});
