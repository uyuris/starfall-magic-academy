import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Extract a top-level `function name(...) { ... }` body from app.js (brace-matched), matching the routing suite's
// helper so an assertion can target one renderer without matching an unrelated line elsewhere.
function appFunction(js, name) {
  const start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function not found in app.js: ${name}`);
  // Skip the parameter list (which may contain destructuring braces) by matching parens first, then brace-match
  // the body from the first `{` after the param list's closing `)`.
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

// ── screen markup ──────────────────────────────────────────────────────────

test('the arena is a dedicated no-tab screen with selection / bracket / match surfaces (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="academy-arena-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-arena-screen section should exist');
  assert.match(block, /class="screen arena-screen"/, 'the screen carries the arena-screen token-layer host class');
  // Phase 1: participate-form selection.
  assert.match(block, /id="arena-selection"/, 'the selection surface exists');
  assert.match(block, /id="arena-selection-modes"/, 'the mode cards render into a container');
  assert.match(block, /<p id="arena-selection-status"[^>]*role="status" aria-live="polite" hidden>/, 'a selection status live region, hidden by default (error banner only)');
  // Phase 2: bracket + terminal result.
  assert.match(block, /id="arena-bracket"[^>]*hidden/, 'the bracket surface exists, hidden by default');
  assert.match(block, /id="arena-bracket-grid"/, 'the bracket rounds render into a grid');
  assert.match(block, /id="arena-bracket-actions"/, 'the bracket carries an action row (試合開始 / 闘技会を出る)');
  assert.match(block, /id="arena-result"[^>]*hidden/, 'the terminal result panel exists, hidden by default');
  // Phase 3/4: match surface (board + HUD + brought column + dock + replay controls).
  assert.match(block, /id="arena-match"[^>]*hidden/, 'the match surface exists, hidden by default');
  assert.match(block, /id="arena-grid"[^>]*role="grid"/, 'the board is a role=grid host');
  assert.match(block, /id="arena-hud-status"/, 'the HUD status region exists');
  assert.match(block, /id="arena-brought"[\s\S]*id="arena-consumables-list"/, 'the brought-item column (持ち込みアイテムのみ) exists');
  assert.doesNotMatch(block, /id="arena-materials"/, 'there is NO pickup column — the arena has no floor loot');
  assert.match(block, /id="arena-spells"[\s\S]*id="arena-heal"/, 'the dock has the spell pills + self-heal');
  assert.match(block, /id="arena-log"[^>]*tabindex="0"/, 'the action log is focusable (keyboard-scroll safe)');
  assert.match(block, /id="arena-consumable-prompt"[^>]*hidden/, 'the consumable targeting prompt exists, hidden by default');
  assert.match(block, /id="arena-replay-controls"[^>]*hidden/, 'the spectator replay controls exist, hidden by default');

  // Tall layout (arena-match-tall-layout): the HUD leads full-width, then a two-column body — the board column
  // (.arena-stage: board + floating prompt) on the left, the right rail (.arena-side) stacking the brought
  // column over the spell/heal dock over the log box (replay controls above the action log, its variable filler).
  const match = block.match(/<div id="arena-match"[\s\S]*?<div id="arena-actor-detail"/)?.[0] ?? '';
  assert.match(match, /class="arena-hud"[\s\S]*class="arena-body"/, 'the HUD leads, then the two-column body follows');
  assert.match(match, /class="arena-body"[\s\S]*class="arena-stage"[\s\S]*id="arena-grid"[\s\S]*id="arena-consumable-prompt"[\s\S]*class="arena-side"/, 'the body holds the board column (grid + prompt) then the right rail');
  assert.match(match, /class="arena-side"[\s\S]*id="arena-items"[\s\S]*class="arena-dock"[\s\S]*class="arena-logbox"/, 'the rail stacks items over the dock over the log box');
  assert.match(match, /class="arena-logbox"[\s\S]*id="arena-replay-controls"[\s\S]*id="arena-log"/, 'the log box carries the replay controls above the action log');
});

test('the arena screen is registered but has no topbar tab (routing-only destination) (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-screen="academy-arena"/, 'the arena is reached via routing dispatch, not a debug tab');
});

// ── app.js wiring ──────────────────────────────────────────────────────────

test('app.js imports the headless-testable arena validators and registers the screen + open hook (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /import \{[\s\S]*validateArenaState[\s\S]*\} from '\.\/arenaClient\.js'/, 'app.js imports the arena validators from the headless client module');
  assert.match(js, /'academy-arena': document\.querySelector\('#academy-arena-screen'\)/, 'the screen is registered in the screens map');
  assert.match(js, /if \(name === 'academy-arena'\) refreshArenaScreen\(\)\.catch\(reportArenaScreenError\)/, 'showScreen opens the arena via refreshArenaScreen');
  // The malformed-payload envelope is refused before any surface renders (fail-fast, no partial paint).
  assert.match(js, /renderArenaState\(validateArenaState\(payload\)\)/, 'the state fetch validates the envelope before rendering');
});

test('the arena reuses the shared brought-item column, effect-summary, and effect-asset helpers (no double definition) (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(appFunction(js, 'renderArenaConsumables'), /fillDungeonItemColumn\(list, view\.consumables, \(row\) => buildArenaConsumableChip\(view, row\)/, 'the brought column reuses the shared fillDungeonItemColumn part');
  assert.match(appFunction(js, 'buildArenaConsumableChip'), /dungeonConsumableSummaryText\(row\)/, 'the chip reuses the shared consumable effect summary');
  assert.match(appFunction(js, 'spawnArenaAssetEffect'), /dungeonEffectAssetUrl\(event\.element, 'bolt'\)/, 'the combat animation reuses the shared per-element effect asset URL');
});

test('the arena board renderer is arena-scoped and does not touch the dungeon renderer (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const render = appFunction(js, 'renderArenaBoard');
  assert.match(render, /\.an-board/, 'the arena board uses arena-scoped .an-* nodes');
  assert.doesNotMatch(render, /renderDungeonGrid|layoutDungeonBoard|dungeonEntityNodes/, 'it does not call or mutate the dungeon board renderer / its entity maps');
});

test('the player match is keyboard-driven (arrow move / space wait), gated to the active interactive match (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /const ARENA_ARROW_DIRS = \{ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' \}/, 'arrow keys map to move directions');
  assert.match(js, /if \(!screens\['academy-arena'\]\.classList\.contains\('active'\)\) return/, 'the handler is gated to the active arena screen');
  assert.match(js, /if \(arenaReplay\) return/, 'a replay frame is a non-interactive surface (no keyboard moves)');
  assert.match(js, /arenaDo\(\{ type: 'move', direction \}\)/, 'an arrow key sends a move action');
  assert.match(js, /arenaDo\(\{ type: 'wait' \}\)/, 'space sends a wait action');
  assert.doesNotMatch(js, /arenaDo\(\{ type: 'descend'/, 'the arena has no descend/retreat (pure combat board)');
});

test('the terminal exit returns to the routing hub through the shared loading-covered hub return (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const exitFn = appFunction(js, 'arenaExit');
  // 闘技会を出る covers the hub-start wait with the academy loading screen (M-2026-07-06-001) via the shared
  // primitive 鍛錬 / 調合 / 工房 use — never a bare enterRoutingHub / navigateToPostContentScreen('interaction')
  // under the still-visible arena screen (which reads as a freeze).
  assert.match(exitFn, /stopArenaReplay\(\);[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\);/, '闘技会を出る stops any replay, then returns to the hub through the shared loading-covered hub return');
  assert.doesNotMatch(exitFn, /navigateToPostContentScreen/, 'the exit no longer goes through the loading-less navigateToPostContentScreen (bare enterRoutingHub = freeze)');
});

test('the arena selection shows unavailable modes disabled with a reason, never hidden (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const render = appFunction(js, 'renderArenaSelection');
  assert.match(render, /card\.disabled = !mode\.available/, 'an unavailable mode card is disabled');
  assert.match(render, /arenaModeUnavailableReasonText\(mode\.reason\)/, 'the disabled card carries the reason text (no silent hide)');
});

test('the arena match dock/consumables fail-fast on a broken engine contract (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(appFunction(js, 'renderArenaDock'), /throw new Error\('arena view is missing healing_spell'\)/, 'a missing healing_spell throws (no silent drop)');
  assert.match(appFunction(js, 'renderArenaConsumables'), /throw new Error\('arena view is missing consumables'\)/, 'a missing consumables contract throws');
  assert.match(appFunction(js, 'onArenaConsumableClick'), /throw new Error\(`unknown consumable target_mode/, 'an unknown target_mode throws');
});

// ── bracket layout (arena-bracket-readable-layout) ──────────────────────────

test('the bracket renders one shared grid, placing each match by explicit row-span doubling and connector roles (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const grid = appFunction(js, 'renderArenaBracketGrid');
  // Server-authoritative: the client still walks bracket.rounds / round as given — it never re-pairs the units.
  assert.match(grid, /view\.bracket\.rounds/, 'the grid reads the server bracket, not a client re-assembly');
  assert.match(grid, /rounds\.forEach\(\(round, roundIndex\)/, 'the grid iterates the server rounds in order');
  assert.match(grid, /className = 'arena-bracket-match'/, 'each match sits in its own slot');
  // The template is driven by the server bracket shape (round count = columns, round-0 match count = base rows),
  // not a hardcoded 4×8 — the skeleton scales with the bracket.
  assert.match(grid, /const baseRows = rounds\[0\]\.length/, 'the base row count comes from the round-0 match count');
  assert.match(grid, /gridTemplateColumns = `repeat\(\$\{nRounds\}/, 'the columns are one per round');
  assert.match(grid, /gridTemplateRows = `auto repeat\(\$\{baseRows\}, minmax\(var\(--arena-bracket-card-min\), 1fr\)\)`/, 'the rows are a header row plus equal per-base-match tracks that never shrink below a card');
  // Explicit row-span doubling: a round-r match spans 2^r base rows, placed from grid line 2 (line 1 = labels).
  assert.match(grid, /const span = 2 \*\* roundIndex/, 'each round spans twice its feeder row count');
  assert.match(grid, /slot\.style\.gridRow = `\$\{2 \+ match\.index \* span\} \/ span \$\{span\}`/, 'a match is placed on its 2^round rows by index — the shared row grid fixes the seam alignment');
  assert.match(grid, /slot\.style\.gridColumn = String\(roundIndex \+ 1\)/, 'a match sits in its round column');
  // The slot carries the connector roles: index parity = feeder side, round position = source/sink.
  assert.match(grid, /match\.index % 2 === 0 \? 'arena-bracket-match--upper' : 'arena-bracket-match--lower'/, 'the slot marks the feeder side by match index parity');
  assert.match(grid, /if \(roundIndex < lastRound\) slot\.classList\.add\('arena-bracket-match--source'\)/, 'a non-final round slot draws the outgoing elbow');
  assert.match(grid, /if \(roundIndex > 0\) slot\.classList\.add\('arena-bracket-match--sink'\)/, 'a non-first round slot draws the incoming stub');
});

test('a match card brackets its two contestants as an A対B pair, watchable when auto-resolved (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const card = appFunction(js, 'buildArenaMatchCard');
  assert.match(card, /buildArenaMatchRow\(view, match, unitsById, match\.team_a_unit_id\)/, 'the card renders team A');
  assert.match(card, /buildArenaMatchRow\(view, match, unitsById, match\.team_b_unit_id\)/, 'the card renders team B');
  assert.match(card, /className = 'arena-match-card-vs'/, 'a 対 divider brackets the pair');
  assert.match(card, /vs\.textContent = '対'/, 'the divider reads 対');
  // A resolved auto (non-player) match stays spectator-replayable.
  assert.match(card, /match\.resolved && match\.is_auto/, 'an auto-resolved match is watchable');
  assert.match(card, /startArenaReplay\(match\.match_id\)/, '観戦 plays the recomputed turn log');
  const row = appFunction(js, 'buildArenaMatchRow');
  assert.match(row, /unitId === view\.player_unit_id.*arena-match-card-row--player/s, 'the player unit row keeps its highlight');
  assert.match(row, /arena-match-card-row--won/, 'the winner row keeps its won class');
  assert.match(row, /mark\.textContent = '✔'/, 'the winner keeps its check mark');
});

test('the bracket is one shared grid with cards centered on equal row tracks, so feeders align on their next match (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const gridBlock = cssRuleBlock(css, '.arena-bracket-grid');
  assert.match(gridBlock, /display:\s*grid/, 'the bracket is a single shared grid, not independent per-round columns');
  assert.match(gridBlock, /--arena-bracket-gutter:/, 'the grid declares the connector gutter length');
  assert.match(gridBlock, /--arena-bracket-card-min:/, 'the grid declares the equal row-track (card) min height');
  assert.match(gridBlock, /--arena-bracket-round-min:/, 'the grid declares the per-round column min width');
  assert.match(gridBlock, /column-gap:\s*var\(--arena-bracket-gutter\)/, 'the round gap is the connector gutter (shared by the elbow math)');
  assert.match(gridBlock, /row-gap:\s*0/, 'the body rows are contiguous so a span-2 cell centers exactly on its feeders shared boundary');
  assert.match(gridBlock, /flex:\s*1/, 'the grid is the flex-bound scroll region');
  assert.match(gridBlock, /overflow:\s*auto/, 'the grid scrolls internally (page height stays bound)');
  const slot = cssRuleBlock(css, '.arena-bracket-match');
  assert.match(slot, /position:\s*relative/, 'the slot is the positioning context for its connector elbows');
  assert.match(slot, /align-items:\s*center/, 'the card centers vertically in its cell (onto the seam)');
  assert.match(slot, /justify-content:\s*center/, 'the card centers horizontally in its cell');
});

test('the bracket draws connector elbows over the gutter with token hairlines only (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const source = cssRuleBlock(css, '.arena-bracket-match--source::after');
  assert.notEqual(source, '', 'the source slot draws an outgoing elbow');
  assert.match(source, /right:\s*calc\(-1 \* var\(--arena-bracket-gutter\) \/ 2\)/, 'the outgoing elbow reaches the gutter mid');
  assert.match(source, /border-right:\s*1px solid var\(--arena-line\)/, 'the vertical run uses the crimson hairline token');
  assert.match(cssRuleBlock(css, '.arena-bracket-match--source.arena-bracket-match--upper::after'), /border-top:\s*1px solid var\(--arena-line\)/, 'the upper feeder elbow runs down from its center');
  assert.match(cssRuleBlock(css, '.arena-bracket-match--source.arena-bracket-match--lower::after'), /border-bottom:\s*1px solid var\(--arena-line\)/, 'the lower feeder elbow runs up from its center');
  const sink = cssRuleBlock(css, '.arena-bracket-match--sink::before');
  assert.match(sink, /left:\s*calc\(-1 \* var\(--arena-bracket-gutter\) \/ 2\)/, 'the incoming stub starts at the gutter mid');
  assert.match(sink, /border-top:\s*1px solid var\(--arena-line\)/, 'the incoming stub uses the crimson hairline token');
  // The layout rules stay token-only over the venue art (no literal color pins, no dungeon tokens).
  for (const selector of ['.arena-bracket-match', '.arena-bracket-match--source::after', '.arena-bracket-match--sink::before', '.arena-match-card-vs']) {
    const block = cssRuleBlock(css, selector);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} pins no literal color`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
});

// ── board face tokens + character detail (arena-board-faces-and-detail) ──────

test('the arena board tokens wear student faces (roster / homunculus) while the protagonist stays a faceless emblem (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const board = appFunction(js, 'renderArenaBoard');
  // The protagonist is the only faceless (emblem) token; every non-protagonist resolves a face image.
  assert.match(board, /if \(actor\.kind === 'protagonist'\) \{ roleClass = 'an-token--self'; glyph = '★'; \}/, 'the protagonist is the faceless self emblem');
  assert.match(board, /imageUrl = arenaActorFaceUrl\(actor\)/, 'a student token resolves a face image');
  // Faces resolve BEFORE the board DOM is mutated (no half-painted board on a roster desync).
  assert.match(board, /const tokenSpecs = view\.actors[\s\S]*tiles\.replaceChildren/, 'token faces resolve before the tiles are painted');
  const token = appFunction(js, 'arenaTokenEl');
  assert.match(token, /if \(imageUrl\) \{[\s\S]*an-token-img/, 'the token renders a face image when given one');
  const resolve = appFunction(js, 'arenaActorFaceUrl');
  assert.match(resolve, /actor\.kind === 'homunculus'[\s\S]*actor\.face_url/, 'a homunculus token uses the enriched face_url');
  assert.match(resolve, /face_url: \$\{actor\.actor_id\}|missing face_url/, 'a homunculus without face_url throws (no default icon)');
  assert.match(resolve, /selectableCharacters[\s\S]*character\.visual_set_id[\s\S]*face_emotions\/neutral\.jpg/, 'a character token resolves its visual set face from the roster by actor_id');
  assert.match(resolve, /not found in character roster[\s\S]*throw|throw new Error\(`arena actor not found in character roster/, 'an unresolvable character throws (roster desync, no silent fallback)');
});

test('every arena actor name (protagonist included) opens the unified actor-detail shell reading the snapshot (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  // HUD + bracket: every name — the protagonist too — is a clickable button (no plain-text protagonist branch).
  const bars = appFunction(js, 'arenaActorBars');
  assert.match(bars, /const name = arenaNameButton\(actor\)/, 'the HUD name is always a button');
  assert.doesNotMatch(bars, /kind === 'protagonist' \? document\.createElement\('span'\)/, 'the protagonist HUD name is no longer plain text');
  const row = appFunction(js, 'buildArenaMatchRow');
  assert.match(row, /unit\.actors\.forEach/, 'the bracket row renders each fighter name individually');
  assert.match(row, /name\.append\(arenaNameButton\(actor\)\)/, 'a bracket fighter name is always a button');
  assert.doesNotMatch(row, /createTextNode\(actor\.name\)/, 'the protagonist bracket name is no longer plain text');
  // The detail is the unified shell: image slot (none for the protagonist) + snapshot parameters + snapshot equipment.
  const detail = appFunction(js, 'openArenaActorDetail');
  assert.match(detail, /buildActorDetailBody\(\{/, 'it builds the unified actor-detail shell body');
  assert.match(detail, /parameterNodes: buildParameterGroups\(actor\.parameters\)/, 'the 能力値 read the projection snapshot parameters (not roster / current world)');
  assert.match(detail, /equipmentNode: buildArenaDetailEquipment\(actor\.equipment \?\? null\)/, 'the 装備 read the projection snapshot equipment');
  assert.match(detail, /acquisitionNode: null/, 'the arena detail has no 獲得予定 section');
  assert.match(detail, /openArenaActorDetailShell\(actor\.name, body\)/, 'it opens the arena actor-detail shell');
  // The image slot: none for the protagonist, standee for a roster character (roster miss → throw), face for a homunculus.
  const image = appFunction(js, 'arenaActorDetailImage');
  assert.match(image, /if \(actor\.kind === 'protagonist'\) return null/, 'the protagonist has no image');
  assert.match(image, /actor\.kind === 'homunculus'[\s\S]*actor\.face_url[\s\S]*shape: 'face'/, 'a homunculus shows its enriched face');
  assert.match(image, /selectableCharacters[\s\S]*\.character_id === actor\.actor_id/, 'a roster character resolves its standee from the roster by actor_id');
  assert.match(image, /if \(!character\) throw new Error/, 'a roster miss throws (fail-fast, not a silent no-op)');
  assert.match(image, /characterSceneStandeeUrl\(character\)[\s\S]*shape: 'standee'/, 'it reuses the shared standee helper');
  // The equipment section reuses the shared slot validator and read-only card (no 解除 button).
  const equip = appFunction(js, 'buildArenaDetailEquipment');
  assert.match(equip, /validateDungeonEquipmentSlots\(runEquipment\.slots, 'arena detail equipment'\)/, 'it validates the run-equipment slots fail-fast');
  assert.match(equip, /buildArenaEquipmentInstanceDetail\(view\)/, 'a filled slot shows the arena-scoped instance card');
  assert.match(equip, /未装備/, 'an empty slot reads 未装備');
});

test('the arena screen carries the unified actor-detail shell instance (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<div id="arena-actor-detail" class="arena-actor-detail actor-detail-shell"[^>]*hidden/, 'the arena carries its own unified actor-detail shell, hidden by default');
  assert.match(html, /id="arena-actor-detail-title"/, 'the shell has a title mount');
  assert.match(html, /id="arena-actor-detail-body"/, 'the shell has a body mount');
  assert.match(html, /data-arena-actor-detail-close="true"/, 'the shell has a close hook');
  // The old split detail surfaces are gone without a trace.
  assert.doesNotMatch(html, /arena-character-detail-dialog|arena-homunculus-detail-popup/, 'the old split character dialog / homunculus popup are removed');
});

test('the arena actor-detail shell + face-token CSS is token-only over the arena layer (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  assert.match(cssRuleBlock(css, '.an-token-img'), /object-fit:\s*cover/, 'the face token image covers the circular token');
  for (const selector of ['.an-token-img', '.arena-name-button', '.arena-icon-button', '.arena-actor-detail .actor-detail-panel', '.arena-actor-detail .actor-detail-backdrop', '.arena-actor-detail .actor-detail-equipment-slot', '.arena-equipment-effect']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} pins no literal color`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
  // The old split-detail selectors are gone.
  assert.doesNotMatch(css, /\.arena-homunculus-detail-/, 'the old homunculus detail CSS is removed');
});

// ── token layer (style.css) — test-by-token ─────────────────────────────────

test('the arena screen is the crimson obsidian ground filling the layout edge-to-edge (direct-background standard, self-contained --arena-* tokens)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const tokens = cssRuleBlock(css, '.arena-screen');
  assert.ok(tokens, '.arena-screen token block should exist');
  for (const token of ['--arena-bg-0', '--arena-ink', '--arena-crimson', '--arena-line', '--arena-panel', '--arena-chip', '--arena-inner-ring', '--arena-shadow']) {
    assert.match(tokens, new RegExp(token.replace(/[-]/g, '\\-')), `.arena-screen declares ${token}`);
  }
  const screen = cssRuleBlock(css, '#academy-arena-screen.active');
  assert.ok(screen, '#academy-arena-screen.active rule should exist');
  assert.match(screen, /background:\s*var\(--arena-bg-0\)/, 'the screen paints the crimson obsidian ground token');
  // No floating-frame chrome: the old border / frame radius / inner-ring + drop-shadow that read as a window on the
  // body's navy gradient is gone, so no navy is revealed as a border (nor at rounded corners).
  assert.doesNotMatch(screen, /border:|border-radius:|box-shadow:/, 'the arena screen drops the floating-window border / radius / shadow chrome (edge-to-edge obsidian, no navy-gradient border)');
  assert.match(screen, /box-sizing:\s*border-box/, 'border-box keeps the inner padding inside the bound height');
  assert.match(screen, /height:\s*100%/, 'the screen fills the viewport-bound height');
  assert.match(screen, /overflow-y:\s*auto/, 'the screen keeps its scroll safety');
  // The layout is edge-to-edge (padding:0) so the flat obsidian ground fills it with no navy-gradient border inset.
  assert.match(css, /body:has\(#academy-arena-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 88px\)\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/, 'the arena layout is edge-to-edge (padding:0) so the flat obsidian ground fills the screen with no navy-gradient border inset (direct-background standard)');
});

test('the arena play panels adopt the --arena-* panel surface tokens (obsidian, blurred like the dungeon)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['.arena-hud', '.arena-dock']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.match(block, /border:\s*1px solid var\(--arena-line\)/, `${selector} adopts the crimson hairline border`);
    assert.match(block, /background:\s*var\(--arena-panel\)/, `${selector} adopts the obsidian translucent panel surface`);
    assert.match(block, /backdrop-filter:\s*blur\(16px\)/, `${selector} blurs over the obsidian ground`);
  }
  const grid = cssRuleBlock(css, '.arena-grid');
  assert.match(grid, /background:\s*var\(--arena-panel\)/, 'the board grid uses the obsidian panel surface');
});

test('the arena surfaces pin no literal color and consume no --dungeon-* token (arena tokens only)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['#academy-arena-screen.active', '.arena-hud', '.arena-dock', '.arena-grid', '.arena-mode-card', '.arena-result']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} is token-only (no literal color pin)`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
});

test('the arena screen has the id-scoped [hidden] guard so its stacked surfaces hide (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  assert.match(css, /#academy-arena-screen \[hidden\]\s*\{\s*display:\s*none;\s*\}/, 'the arena screen carries the id-scoped [hidden] guard (like the dungeon)');
});

// ── stage art wiring (arena-art-wiring) ─────────────────────────────────────

test('the bracket frame wears the fixed venue background under a token scrim (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const bracket = cssRuleBlock(css, '.arena-bracket');
  assert.ok(bracket, '.arena-bracket rule should exist');
  assert.match(bracket, /background-image:\s*linear-gradient\(var\(--arena-scrim\), var\(--arena-scrim\)\), url\('\/canonical\/arena\/stage\.jpg'\)/, 'the bracket lays the fixed venue image under an --arena-scrim veil');
  assert.match(bracket, /background-size:\s*cover/, 'the venue image covers the bracket frame');
  assert.match(bracket, /position:\s*relative/, 'the bracket is the positioning context for the corner ornaments');
  const selection = cssRuleBlock(css, '#academy-arena-screen .arena-selection');
  assert.match(selection, /url\('\/canonical\/arena\/stage\.jpg'\)/, 'the selection surface shares the venue background');
  assert.match(selection, /var\(--arena-scrim-strong\)/, 'the selection venue sits under the stronger scrim token');
});

test('the bracket contestant rows wear the plate pedestal with legible ink (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const row = cssRuleBlock(css, '.arena-match-card-row');
  assert.ok(row, '.arena-match-card-row rule should exist');
  assert.match(row, /background-image:\s*url\('\/canonical\/arena\/plate\.png'\)/, 'each unit row is seated on the fixed plate pedestal');
  const name = cssRuleBlock(css, '.arena-match-card-name');
  assert.match(name, /text-shadow:\s*[^;]*var\(--arena-shadow-strong\)/, 'the unit name keeps contrast over the plate via a token shadow');
});

test('the bracket frame carries the four rotated corner ornaments, non-interactive (index.html + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const bracketMarkup = html.match(/<div id="arena-bracket"[\s\S]*?<header/)?.[0] ?? '';
  assert.notEqual(bracketMarkup, '', 'the bracket opening markup should exist');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    assert.match(bracketMarkup, new RegExp(`arena-corner arena-corner-${corner}" src="/canonical/arena/corner_arena\\.png"`), `the ${corner} corner places the shared arena corner ornament`);
  }
  assert.match(cssRuleBlock(css, '.arena-corner'), /pointer-events:\s*none/, 'the corner ornaments never intercept clicks');
  assert.match(cssRuleBlock(css, '.arena-corner-tr'), /transform:\s*rotate\(90deg\)/, 'the top-right corner is the +90° rotation');
  assert.match(cssRuleBlock(css, '.arena-corner-bl'), /transform:\s*rotate\(-90deg\)/, 'the bottom-left corner is the -90° rotation');
  assert.match(cssRuleBlock(css, '.arena-corner-br'), /transform:\s*rotate\(180deg\)/, 'the bottom-right corner is the 180° rotation');
});

test('the added arena stage-art rules pin no literal color (token-only over the art)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['.arena-bracket', '#academy-arena-screen .arena-selection', '.arena-match-card-row', '.arena-corner']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} pins no literal color (scrim / ink via --arena-* tokens only)`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
});

// ── board scale freeze (board-scale-stabilize) ──────────────────────────────

test('the arena board scale is frozen per window size so a content toggle never rezooms it (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const layout = appFunction(js, 'layoutArenaBoard');
  // The cell is reused from the frozen lock unless the WINDOW itself changed — so hiding the dock / item /
  // prompt / replay regions (which resizes the inner stage, sharply at 決着) reuses the scale, never re-fits.
  assert.match(layout, /window\.innerWidth/, 'the freeze is keyed on the window size');
  assert.match(layout, /arenaCellLock !== null && arenaCellLockWindow[\s\S]*arenaCellLockWindow\.w === win\.w && arenaCellLockWindow\.h === win\.h/, 'a matching window size reuses the frozen cell instead of re-fitting');
  assert.match(layout, /arenaCellLock = cell;\s*\n\s*arenaCellLockWindow = win;/, 'a fresh fit records the frozen cell + the window it was computed for');
  // The lock resets when leaving the match surface / on screen (re)open, never per action — so each match
  // re-fits under its own first (interactive) layout, but keeps its scale from start through 決着.
  assert.match(appFunction(js, 'resetArenaBoardScale'), /arenaCellLock = null;\s*\n\s*arenaCellLockWindow = null;/, 'the reset drops the frozen scale');
  assert.match(appFunction(js, 'showArenaSurface'), /if \(name !== 'match'\) \{ resetArenaBoardScale\(\); clearArenaMatchIntro\(\); \}/, 'leaving the match surface drops the frozen scale and clears the intro banner');
  assert.match(appFunction(js, 'refreshArenaScreen'), /resetArenaBoardScale\(\)/, 'a screen (re)open drops the frozen scale');
  // A real window resize is the only thing that re-fits: the arena ResizeObserver still calls layoutArenaBoard,
  // which reuses the frozen cell unless the window changed.
  assert.match(js, /new ResizeObserver\(\(\) => \{[\s\S]*layoutArenaBoard\(currentArenaMatchView\)/, 'the arena ResizeObserver refits through the frozen layoutArenaBoard');
});

// ── tall layout (arena-match-tall-layout) — board column + stacked right rail ───────────────

test('the match is a two-column body: the board column fills the left, the right rail stacks items/dock/log (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  // The board column takes the 6-share of the body width, the right rail the 5-share (mirrors the dungeon
  // tall layout), and the board fills its column so it renders as a large near-square viewport to the bottom.
  assert.match(cssRuleBlock(css, '.arena-body'), /display:\s*flex/, 'the body is a flex row');
  assert.match(cssRuleBlock(css, '.arena-body'), /min-height:\s*0/, 'the body can shrink so its children own the height');
  assert.match(cssRuleBlock(css, '.arena-stage'), /flex:\s*6/, 'the board column takes 6 of the match body');
  assert.match(cssRuleBlock(css, '.arena-stage'), /position:\s*relative/, 'the board column anchors the floating targeting prompt');
  assert.match(cssRuleBlock(css, '.arena-side'), /flex:\s*5/, 'the right rail takes 5 of the match body');
  assert.match(cssRuleBlock(css, '.arena-side'), /flex-direction:\s*column/, 'the right rail stacks its sections vertically');
  assert.match(cssRuleBlock(css, '.arena-grid'), /flex:\s*1/, 'the board fills its column');
  // The item region and dock keep fixed heights; the log box is the rail's variable filler (its log scrolls
  // internally). That is what makes the board viewport — and so --an-cell — independent of the rail content.
  assert.match(cssRuleBlock(css, '.arena-items'), /flex:\s*0 0 auto/, 'the brought column is a fixed-height rail section');
  assert.match(cssRuleBlock(css, '.arena-dock'), /flex:\s*0 0 auto/, 'the spell/heal dock is a fixed-height rail section');
  assert.match(cssRuleBlock(css, '.arena-logbox'), /flex:\s*1 1 0/, 'the log box takes the rail vertical slack');
  assert.match(cssRuleBlock(css, '.arena-logbox'), /min-height:\s*0/, 'the log box can shrink so its log scrolls');
  assert.match(cssRuleBlock(css, '.arena-log'), /flex:\s*1/, 'the action log fills the log box');
  assert.match(cssRuleBlock(css, '.arena-log'), /min-height:\s*0/, 'the action log scrolls internally instead of growing the rail');
  assert.match(cssRuleBlock(css, '.arena-log'), /overflow-y:\s*auto/, 'the action log scrolls within its section');
  // On a non-interactive frame (spectate / resolved) the match hides #arena-dock-main; the dock panel collapses
  // with it so the rail shows only the log box, never an empty bordered box.
  assert.match(css, /\.arena-dock:has\(> #arena-dock-main\[hidden\]\)\s*\{\s*display:\s*none;\s*\}/, 'the dock collapses when its only child is hidden');
});

test('the tall-layout arena rules pin no literal color and borrow no dungeon token (arena tokens only)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['.arena-body', '.arena-stage', '.arena-side', '.arena-logbox', '.arena-log']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} pins no literal color`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
});

// ── layout stability + replay speed (arena-ui-stability-and-replay-speed) ────

test('the 試合前口上 banner is a fixed two-line slot that scrolls internally, so its state changes never shift the board (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const intro = cssRuleBlock(css, '.arena-match-intro');
  assert.ok(intro, '.arena-match-intro rule should exist');
  assert.match(intro, /box-sizing:\s*border-box/, 'border-box keeps the padding + border inside the fixed height');
  assert.match(intro, /height:\s*calc\(1\.7em \* 2 \+ 22px\)/, 'the banner is fixed at two text lines (plus its padding + border)');
  assert.match(intro, /overflow-y:\s*auto/, 'a body over two lines scrolls within the slot instead of growing it');
  assert.match(intro, /flex:\s*0 0 auto/, 'the banner never flex-grows or shrinks its fixed height');
  assert.doesNotMatch(intro, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, '.arena-match-intro pins no literal color');
  assert.doesNotMatch(intro, /--dungeon-|--dn-/, '.arena-match-intro does not borrow the dungeon token layer');
});

test('the 実況一文 slot is a fixed two-line height that scrolls internally, so its state never changes the result panel height (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const flavor = cssRuleBlock(css, '.arena-result-flavor');
  assert.ok(flavor, '.arena-result-flavor rule should exist');
  assert.match(flavor, /box-sizing:\s*border-box/, 'border-box keeps the height deterministic');
  assert.match(flavor, /height:\s*calc\(1\.6em \* 2\)/, 'the flavor line is fixed at two text lines');
  assert.match(flavor, /overflow-y:\s*auto/, 'an over-long 実況一文 scrolls within the slot');
  assert.doesNotMatch(flavor, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, '.arena-result-flavor pins no literal color');
  assert.doesNotMatch(flavor, /--dungeon-|--dn-/, '.arena-result-flavor does not borrow the dungeon token layer');
});

test('the HUD round number reserves a fixed 4-digit tabular width so a digit-count change never shifts the layout (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const hud = appFunction(js, 'renderArenaHud');
  assert.match(hud, /arenaChipEl\('ラウンド', String\(view\.round \+ 1\)\)/, 'the round chip still shows the 1-based round');
  assert.match(hud, /roundChip\.classList\.add\('arena-round-chip'\)/, 'the round chip carries the fixed-width marker class');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  assert.match(css, /\.an-hud-chip strong\s*\{[^}]*font-variant-numeric:\s*tabular-nums/, 'the chip value is tabular (equal-advance digits)');
  const roundStrong = cssRuleBlock(css, '.arena-round-chip strong');
  assert.ok(roundStrong, '.arena-round-chip strong rule should exist');
  assert.match(roundStrong, /display:\s*inline-block/, 'the value is inline-block so it can reserve a width');
  assert.match(roundStrong, /min-width:\s*4ch/, 'the value reserves four tabular digits from the start (1→2→3→4 digits fit)');
});

test('the spectator replay has a session-held 3-step speed (低速 baseline / 中速 ½ / 高速 ¼), pacing only (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  // Session-held selection, defaulting to 低速 (= the unchanged baseline interval); it is never reset, so it carries
  // across replays for the page session (no backend save).
  assert.match(js, /let arenaReplaySpeed = 'low';/, 'the speed selection defaults to 低速 and lives in a session var');
  assert.match(js, /const ARENA_REPLAY_STEP_MS = 1100;/, '低速 keeps the unchanged 1100ms baseline interval');
  assert.match(js, /const ARENA_REPLAY_SPEED_DIVISORS = \{ low: 1, mid: 2, high: 4 \};/, '中速 halves and 高速 quarters the baseline');
  // The scheduler divides the baseline by the selected speed; a change takes effect on the next scheduled step.
  const stepMs = appFunction(js, 'arenaReplayStepMs');
  assert.match(stepMs, /ARENA_REPLAY_STEP_MS \/ ARENA_REPLAY_SPEED_DIVISORS\[arenaReplaySpeed\]/, 'the interval is the baseline divided by the selected speed');
  assert.match(appFunction(js, 'arenaScheduleReplayStep'), /window\.setTimeout\(\(\) => arenaReplayAdvance\(\), arenaReplayStepMs\(\)\)/, 'the auto-advance uses the speed-adjusted interval, not the raw constant');
  // The selection is not reset when a replay stops or the screen re-opens (it must carry across replays), and it is
  // not persisted (no storage / backend write of the speed).
  assert.doesNotMatch(appFunction(js, 'stopArenaReplay'), /arenaReplaySpeed\s*=/, 'stopping a replay does not reset the session speed');
  assert.doesNotMatch(appFunction(js, 'refreshArenaScreen'), /arenaReplaySpeed\s*=/, 'a screen (re)open does not reset the session speed');
  assert.doesNotMatch(js, /localStorage[^\n]*arenaReplaySpeed|arenaReplaySpeed[^\n]*localStorage/, 'the speed is not persisted to storage');
});

test('the replay controls render the 3-step speed toggle, marking the selected speed and switching it in place (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(appFunction(js, 'renderArenaReplayControls'), /node\.append\(info, arenaReplaySpeedControl\(\)\)/, 'the controls include the speed toggle');
  const control = appFunction(js, 'arenaReplaySpeedControl');
  assert.match(control, /for \(const key of \['low', 'mid', 'high'\]\)/, 'the toggle offers the three speeds in order');
  assert.match(control, /ARENA_REPLAY_SPEED_LABELS\[key\]/, 'each button is labelled 低速 / 中速 / 高速');
  assert.match(control, /const selected = arenaReplaySpeed === key/, 'the current session speed is the selected one');
  assert.match(control, /button\.classList\.toggle\('is-selected', selected\)/, 'the selected speed is marked');
  assert.match(control, /arenaReplaySpeed = key; renderArenaReplayControls\(\)/, 'picking a speed updates the session var and re-marks the controls');
});

test('the replay speed toggle CSS is token-only over the arena layer (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['.arena-replay-speed', '.arena-replay-speed-button', '.arena-replay-speed-button.is-selected']) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} rule should exist`);
    assert.doesNotMatch(block, /rgba\(|rgb\(|#[0-9a-fA-F]{3,6}\b/, `${selector} pins no literal color`);
    assert.doesNotMatch(block, /--dungeon-|--dn-/, `${selector} does not borrow the dungeon token layer`);
  }
  assert.match(cssRuleBlock(css, '.arena-replay-speed-button.is-selected'), /border-color:\s*var\(--arena-crimson\)/, 'the selected speed reads as the crimson accent');
});

// ── the dungeon stays byte-equivalent (regression guard) ────────────────────

test('the dungeon token layer + frame are unchanged by the arena addition (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const dungeonTokens = cssRuleBlock(css, '.dungeon-screen');
  assert.match(dungeonTokens, /--dungeon-amber:\s*#f0b24a/, 'the dungeon amber accent token is unchanged');
  const dungeonFrame = cssRuleBlock(css, '#academy-dungeon-screen.active');
  assert.match(dungeonFrame, /background:\s*var\(--dungeon-bg-0\)/, 'the dungeon screen still paints its own obsidian ground token (unaffected by the arena addition)');
  assert.doesNotMatch(dungeonFrame, /border:|border-radius:|box-shadow:/, 'the dungeon screen is edge-to-edge obsidian with no floating-frame chrome (unaffected by the arena addition)');
});
