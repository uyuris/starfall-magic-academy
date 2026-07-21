import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { definitionsRoot, assetsRoot } from './testPaths.mjs';

// The daytime (conversation-day) stage frame paints the SQUARE crop of the current stage background, derived
// mechanically from the wide background_url: keep the exact basename, swap only the directory to
// /canonical/backgrounds/square/ (conversationDaySquareStageUrl in app.js). The derivation has no per-location
// map and no wide fallback, so a location whose square crop is missing would fail to render with no rescue. This
// repo test pins the existence side of that contract: every unique background referenced by locations.json must
// have a same-basename square asset on disk, so adding a stage without its square art is caught structurally.
const squareDir = path.join(assetsRoot, 'canonical/backgrounds/square');

// The mechanical wide→square derivation the stage frame relies on (basename preserved, square directory).
function squareAssetBasename(backgroundUrl) {
  return backgroundUrl.slice(backgroundUrl.lastIndexOf('/') + 1);
}

async function uniqueLocationBackgroundUrls() {
  const raw = JSON.parse(await readFile(path.join(definitionsRoot, 'locations.json'), 'utf8'));
  assert.ok(Array.isArray(raw), 'locations.json is an array of location definitions');
  const urls = raw.map((location) => location.background_url).filter((url) => typeof url === 'string' && url !== '');
  return [...new Set(urls)].sort();
}

test('every unique conversation-day stage background has a same-basename square crop on disk', async () => {
  const backgroundUrls = await uniqueLocationBackgroundUrls();
  // The current stage roster resolves to 34 unique backgrounds; pin the count so a stage addition that skips the
  // square crop batch trips this test instead of silently shipping a frame that fails to load.
  assert.equal(backgroundUrls.length, 34, 'locations.json references 34 unique stage backgrounds');
  for (const backgroundUrl of backgroundUrls) {
    const squareFile = path.join(squareDir, squareAssetBasename(backgroundUrl));
    const buf = await readFile(squareFile);
    assert.ok(buf.length > 0, `${backgroundUrl} → ${path.basename(squareFile)} exists under /canonical/backgrounds/square/ and is non-empty`);
  }
});
