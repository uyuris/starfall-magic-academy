import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Extract a top-level `function name(...) { ... }` body from app.js (brace-matched), so an assertion targets one
// function without matching an unrelated line elsewhere. (Mirrors the helper in uiIntegration.auctionConsignment.test.mjs.)
function appFunction(js, name) {
  const start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function not found in app.js: ${name}`);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = start + `function ${name}`.length; i < js.length; i += 1) {
    const ch = js[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') { parenDepth -= 1; if (parenDepth === 0) { bodyStart = js.indexOf('{', i); break; } }
  }
  if (bodyStart === -1) throw new Error(`could not find body for app.js function: ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < js.length; i += 1) {
    const ch = js[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return js.slice(start, i + 1); }
  }
  throw new Error(`unterminated function in app.js: ${name}`);
}

// ── 出品側: the 籠入りの生き物 (star_cradle_creature) source folds into the existing picker ─────────────────────

test('the consignment picker enumerates the caged section from the options view (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const render = appFunction(js, 'renderAuctionConsignmentOptions');
  // caged is spread into the same entries list — a caged option shares the equipment/item markup, and the empty
  // aggregation (`empty.hidden = entries.length > 0`) counts caged too (no separate silent-hide section).
  assert.match(render, /\[\.\.\.options\.equipment, \.\.\.options\.items, \.\.\.options\.caged\]/, 'caged options fold into the shared entries list');
  assert.match(render, /empty\.hidden = entries\.length > 0/, 'the empty note aggregates all three sources (caged included)');
  // A caged creature submits by instance_id (like equipment), never by item_id; keying off item vs. instance keeps
  // star_cradle_creature flowing through the shared submit with no caged-specific branch.
  assert.match(render, /entry\.kind === 'item'\s*\n?\s*\?\s*\{ kind: 'item', item_id: entry\.item_id \}\s*\n?\s*:\s*\{ kind: entry\.kind, instance_id: entry\.instance_id \}/, 'the source is keyed item→item_id / else→instance_id (folds star_cradle_creature in)');
  // The display values come straight from the view (name/category_label/band); the frontend does not re-derive them.
  assert.match(render, /entry\.category_label/, 'the option meta shows the view-provided category_label');
  assert.match(render, /entry\.band/, 'the option meta shows the view-provided band');
});

test('the consignment picker fails fast when the options view drops the caged array (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const render = appFunction(js, 'renderAuctionConsignmentOptions');
  // A missing array is a broken upstream contract, not an empty-list default (no `?? []`): all three arrays are
  // required or the render throws before touching the DOM.
  assert.match(render, /!Array\.isArray\(options\.equipment\) \|\| !Array\.isArray\(options\.items\) \|\| !Array\.isArray\(options\.caged\)/, 'all three option arrays are required');
  assert.match(render, /throw new Error\('auction consignment options must carry equipment, items, and caged arrays'\)/, 'a missing array throws (no silent empty render)');
  assert.doesNotMatch(render, /options\.caged \?\?/, 'the caged array has no default fallback');
});

// ── 落札側: the caged_creature house lot rides the generic house path (no category branch) ───────────────────

test('a caged_creature house lot is not gated by the being adoptable-slot check (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const loop = appFunction(js, 'runAuctionBidLoop');
  // The player can always bid on a caged_creature lot: the only bid gate keys off being + adoptable === false, and a
  // caged lot has no adoptable field (籠入りは容量無制限). No caged-specific branch is added.
  assert.match(loop, /lot\.category === 'being' && lot\.adoptable === false/, 'the only bid gate is a full 錬成室 for a being lot');
  assert.doesNotMatch(loop, /caged_creature/, 'the bid loop adds no caged_creature branch (generic path)');
});

test('a player-won caged_creature house lot narrates its 籠入り destination from the view (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const resolve = appFunction(js, 'resolveAuctionCurrentLot');
  // The lot is captured before the resolve reassigns auctionSlotView to the advanced slot.
  assert.match(resolve, /const lot = auctionLotView\(lotIndex\);/, 'the resolving lot is captured before the slot advances');
  assert.match(resolve, /winner === AUCTION_PLAYER_WINNER_ID/, 'the caged narration is scoped to the player win');
  assert.match(resolve, /lot\.category === 'caged_creature'\) await appendAuctionNarration\(auctionCagedCreatureAwardNarration\(lot\)\)/, 'a player-won caged_creature lot narrates its 籠入り destination');
  const narration = appFunction(js, 'auctionCagedCreatureAwardNarration');
  assert.match(narration, /lot\.name/, 'the narration names the lot from the view (no re-derivation)');
  assert.match(narration, /星の揺り籠の籠入り/, 'the narration names the 星の揺り籠 caged destination');
});
