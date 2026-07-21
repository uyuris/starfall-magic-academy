import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock } from './fixtures/uiSource.mjs';

// 星の揺り籠 (star cradle) frontend contract tests (test-by-token against the shipped index.html / app.js /
// style.css). The garden overlay is a hub-only side-road driven by the 8 backend routes; these assertions pin
// its markup, wiring, operation dispatch, view-derived rendering, fail-fast, animation, asset-path 規約, and
// --routing-* token discipline — and that the shared routing hub / loop surfaces stay untouched.

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

test('star cradle: hub entrance + garden overlay markup (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');

  // The entrance is the drifting 天球儀 decor (decor-1) itself, promoted to a clickable button: it reuses the
  // shared .routing-hub-decor / .routing-hub-decor-1 drift+position classes, carries an accessible name (title +
  // aria-label) + dialog semantics, and shows the celestial-globe decor art (decorative — the name is on the
  // button). No dedicated icon+label entrance, and no separate cradle icon asset, remains.
  assert.match(html, /<button type="button" id="routing-hub-cradle-globe" class="routing-hub-decor routing-hub-decor-1 routing-hub-cradle-globe" title="星の揺り籠" aria-label="星の揺り籠を開く" aria-haspopup="dialog">/, 'the entrance is the 天球儀 decor promoted to a named/clickable button');
  assert.match(html, /<img class="routing-hub-cradle-globe-img" src="\/canonical\/routing\/decor\/decor_01\.png" alt="" aria-hidden="true" \/>/, 'the entrance shows the celestial-globe decor art (decorative, name on the button)');
  // The old dedicated icon+label entrance (markup + its icon/label sub-elements) is fully removed. The overlay
  // header keeps its own cradle_icon.png, so only the entrance markers are asserted absent.
  assert.doesNotMatch(html, /routing-hub-cradle-entrance/, 'the old dedicated icon+label entrance is fully removed');

  // The overlay follows the routing hub modal 流儀: [hidden] toggle, a data-routing-popup-close backdrop, a
  // role=dialog card, a status line, and a body the JS renders into.
  assert.match(html, /<div id="routing-hub-star-cradle" class="routing-hub-star-cradle" hidden>/, 'the garden overlay is [hidden]-toggled');
  assert.match(html, /<div class="routing-hub-star-cradle-backdrop" data-routing-popup-close="true"><\/div>/, 'the overlay backdrop closes on click (data-routing-popup-close)');
  assert.match(html, /<div class="routing-hub-star-cradle-card" role="dialog" aria-modal="true" aria-labelledby="routing-hub-star-cradle-title">/, 'the overlay card is a labelled modal dialog');
  assert.match(html, /<button type="button" class="routing-hub-info-popup-close" data-routing-popup-close="true" aria-label="閉じる">×<\/button>/, 'the overlay reuses the shared routing close button');
  assert.match(html, /<p id="routing-hub-star-cradle-status" class="routing-hub-star-cradle-status" role="status" aria-live="polite" hidden><\/p>/, 'the overlay has a status/busy line');
  assert.match(html, /<div id="routing-hub-star-cradle-body" class="routing-hub-star-cradle-body"><\/div>/, 'the overlay has a JS-rendered body');

  // The entrance/overlay are added inside #routing-hub-screen (a hub-only surface), not another screen.
  const hubScreen = html.match(/<section id="routing-hub-screen"[\s\S]*?\n {6}<\/section>/)?.[0] ?? '';
  assert.match(hubScreen, /routing-hub-cradle-globe/, 'the entrance lives inside the routing hub screen');
  assert.match(hubScreen, /routing-hub-star-cradle/, 'the overlay lives inside the routing hub screen');
});

test('star cradle: open/close wiring + hub-exit close (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The entrance opens the overlay; the close button + backdrop dismiss it — both fail-fast on broken markup,
  // surfaced via reportError (the same 流儀 as the other routing hub popups).
  assert.match(js, /document\.querySelector\('#routing-hub-cradle-globe'\)\.addEventListener\('click', \(\) => \{\s*\n\s*try \{ openRoutingHubStarCradle\(\); \} catch \(error\) \{ reportError\(error\); \}\s*\n\s*\}\);/, 'the entrance click opens the overlay (reportError on broken markup)');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#routing-hub-star-cradle \[data-routing-popup-close\]'\)\) \{\s*\n\s*closer\.addEventListener\('click', \(\) => \{\s*\n\s*try \{ closeRoutingHubStarCradle\(\); \} catch \(error\) \{ reportError\(error\); \}/, 'the overlay close controls dismiss it (reportError on broken markup)');

  // Leaving the routing hub closes the overlay so it never persists across screens (alongside stage.closeInfo).
  assert.match(js, /if \(name !== 'routing-hub'\) \{[\s\S]*?routingHubStage\.closeInfo\(\);[\s\S]*?closeRoutingHubStarCradle\(\);\s*\n\s*\}/, 'leaving the hub closes the star cradle overlay');

  // Open fetches the view (LM-independent, no loading screen); close is a plain [hidden] toggle. Both fail-fast.
  // Both also drive the BGM sync (overlay override → v6-cradle on open, current screen track on close).
  assert.match(js, /function openRoutingHubStarCradle\(\) \{[\s\S]*?overlay\.hidden = false;\s*\n\s*syncBgmForUiState\(\);[\s\S]*?loadRoutingHubStarCradleView\(\)\.catch\(reportError\);/, 'open reveals the overlay, syncs BGM, and loads the view');
  assert.match(js, /function openRoutingHubStarCradle\(\) \{[\s\S]*?if \(!overlay\) throw new Error/, 'open fail-fasts on a missing overlay node');
  assert.match(js, /function closeRoutingHubStarCradle\(\) \{[\s\S]*?if \(!overlay\) throw new Error[\s\S]*?overlay\.hidden = true;\s*\n\s*syncBgmForUiState\(\);/, 'close fail-fasts on a missing overlay node, hides it, then syncs BGM');
});

test('star cradle: the 8 routes are dispatched with the contract bodies (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  assert.match(js, /const STAR_CRADLE_REQUEST_PATH = '\/api\/star-cradle';/, 'the star cradle base path is the backend route');
  assert.match(js, /view = await getJson\(STAR_CRADLE_REQUEST_PATH\);/, 'the view is read from GET /api/star-cradle');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/plant`, \{ item_id: itemId \}\)/, 'plant posts { item_id }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/feed`, \{ kind, slot_index: slotIndex, material_item_id: materialItemId \}\)/, 'feed posts { kind, slot_index, material_item_id }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/harvest`, \{ slot_index: slotIndex \}\)/, 'harvest posts { slot_index }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/byproduct`, \{ slot_index: slotIndex \}\)/, 'byproduct posts { slot_index }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/name`, \{ slot_index: slotIndex, name \}\)/, 'name posts { slot_index, name }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/cage`, \{ slot_index: slotIndex \}\)/, 'cage posts { slot_index }');
  assert.match(js, /postJson\(`\$\{STAR_CRADLE_REQUEST_PATH\}\/release`, \{ instance_id: instanceId \}\)/, 'release posts { instance_id }');

  // Every op is single-flight, adopts the authoritative inventory only when the op returns one, re-renders from
  // the response view (bumping the token so a late initial fetch can't clobber it), shows a 400/409 near the
  // action, and re-throws anything else to reportError.
  const runFn = js.match(/async function runStarCradleAction\(request\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(runFn, /if \(starCradleActionInFlight\) return;/, 'the op runner is single-flight');
  assert.match(runFn, /if \(result\.inventory\) currentInventory = result\.inventory;/, 'the op adopts the authoritative inventory when returned (no fabricated inventory)');
  assert.match(runFn, /starCradleViewToken \+= 1;\s*\n\s*renderRoutingHubStarCradleView\(result\.view\);/, 'the op re-renders from the response view and bumps the view token');
  assert.match(runFn, /if \(!isStarCradleClientError\(error\)\) \{ reportError\(error\); return; \}\s*\n\s*setStarCradleStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);/, 'a 400/409 surfaces near the action; anything else goes to reportError');
});

test('star cradle: rendered values are view-derived (no frontend growth recompute) (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Sprites resolve from the view's revealed/adult flags + variety/mutation ids — never a re-derived growth
  // stage. The pre-bloom plant sprite is keyed by the view's stage string (unknown stage throws, no fallback).
  const plantSprite = js.match(/function starCradlePlantSpriteUrl\(view\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(plantSprite, /if \(view\.revealed\) return starCradleAssetUrl\(`varieties\/\$\{view\.variety\.id\}\.png`\);/, 'a bloomed pot uses its variety art');
  assert.match(plantSprite, /const sprite = STAR_CRADLE_PLANT_STAGE_SPRITE\[view\.stage\];\s*\n\s*if \(!sprite\) throw new Error/, 'a pre-bloom pot maps the view stage to a sprite and throws on an unknown stage');
  const creatureSprite = js.match(/function starCradleCreatureSpriteUrl\(view\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(creatureSprite, /if \(!view\.revealed\) return starCradleAssetUrl\('stages\/egg\.png'\);/, 'a pre-hatch creature is the egg sprite');
  assert.match(creatureSprite, /if \(!view\.adult\) return starCradleAssetUrl\(`creatures\/\$\{view\.variety\.id\}_juvenile\.png`\);/, 'a hatched non-adult is the juvenile sprite');
  assert.match(creatureSprite, /if \(view\.mutation\) return starCradleAssetUrl\(`creatures\/\$\{view\.variety\.id\}_\$\{view\.mutation\.id\}\.png`\);/, 'a mutated adult is the mutation sprite');
  assert.match(creatureSprite, /return starCradleAssetUrl\(`creatures\/\$\{view\.variety\.id\}_adult\.png`\);/, 'a plain adult is the adult sprite');

  // The slot rows fill by view slot_index and total counts; the plant section reads free slot counts from the
  // view. No growth math (elapsed*3/mature etc.) in the render path.
  assert.match(js, /starCradleSlotRow\('鉢', view\.pot_slots, view\.pots,/, 'the pot row uses view.pot_slots / view.pots');
  assert.match(js, /starCradleSlotRow\('生き物', view\.creature_slots, view\.creatures,/, 'the creature row uses view.creature_slots / view.creatures');
  assert.match(js, /空き — 鉢 \$\{view\.free_pot_slots\} \/ 生き物 \$\{view\.free_creature_slots\}/, 'the plant section shows the view free-slot counts');
  assert.doesNotMatch(js, /weeks_elapsed \* 3|elapsed \* 3|Math\.floor\(\(view\.weeks_elapsed/, 'the render path does not re-derive a growth stage from weeks');
});

test('star cradle: candidate detection + contract-known disables + fail-fast (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Plant candidates come from inventory by the authored seed item_id pattern (no catalog route, no hardcoded
  // id list); feed candidates by the material item_id pattern. Both fail-fast on a missing items array.
  assert.match(js, /const STAR_CRADLE_SEED_ITEM_PATTERN = \/\^star_cradle_\[a-z_\]\+\$\/;/, 'seed candidates use the authored star cradle item_id pattern');
  assert.match(js, /const STAR_CRADLE_MATERIAL_ITEM_PATTERN = \/\^material_\[a-z\]\+_t\[1-4\]\$\/;/, 'feed candidates use the attribute-material item_id pattern');
  assert.match(js, /function starCradleSeedCandidates\(\) \{[\s\S]*?if \(!Array\.isArray\(items\)\) \{\s*\n\s*throw new Error[\s\S]*?items\.filter\(\(item\) => STAR_CRADLE_SEED_ITEM_PATTERN\.test\(item\.item_id\)\)/, 'seed candidates fail-fast on a non-array inventory and filter by the pattern');
  assert.match(js, /function starCradleMaterialCandidates\(\) \{[\s\S]*?if \(!Array\.isArray\(items\)\) \{\s*\n\s*throw new Error[\s\S]*?items\.filter\(\(item\) => STAR_CRADLE_MATERIAL_ITEM_PATTERN\.test\(item\.item_id\)\)/, 'feed candidates fail-fast on a non-array inventory and filter by the pattern');

  // No candidates → an explicit note (never a silent empty list).
  assert.match(js, /植えられる種や卵を持っていません。/, '0 plant candidates shows an explicit note');
  assert.match(js, /餌にできる属性素材を持っていません。/, '0 feed candidates shows an explicit note');

  // Contract-known-impossible actions are disabled with a reason rather than firing a doomed request: 収穫 only
  // renders for a bloomed pot, 副産物 disables with a reason when 0 weeks are pending, 籠に入れる keys off cageable.
  const plantCard = js.match(/function starCradlePlantSlotCard\(view\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(plantCard, /if \(view\.revealed\) \{[\s\S]*?starCradleActionButton\('収穫する'/, '収穫 only renders once bloomed');
  const byproduct = js.match(/function starCradleByproductAction\(view\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(byproduct, /if \(pending > 0\) \{[\s\S]*?\}\s*\n\s*const wrap[\s\S]*?disabled: true[\s\S]*?今週分は受け取り済みです。/, '副産物 disables with a reason when nothing is due');
  assert.match(js, /starCradleActionButton\('籠に入れる', \(\) => starCradleCage\(view\.slot_index\), \{ disabled: !view\.cageable \}\)/, '籠に入れる disables off the cageable contract flag');

  // A disabled button fires nothing; overlay body/status accessors fail-fast on broken markup.
  assert.match(js, /function starCradleActionButton\([\s\S]*?if \(disabled\) \{\s*\n\s*button\.disabled = true;\s*\n\s*return button;/, 'a disabled action button binds no click');
  assert.match(js, /function renderRoutingHubStarCradleView\(view\) \{[\s\S]*?if \(!body\) throw new Error/, 'the view render fail-fasts on a missing body node');
  assert.match(js, /function setStarCradleStatus\([\s\S]*?if \(!status\) throw new Error/, 'the status setter fail-fasts on a missing status node');
});

test('star cradle: fixed asset-path 規約 (no fallback / existence-check path) (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  assert.match(js, /const STAR_CRADLE_ASSET_ROOT = '\/canonical\/star_cradle';/, 'assets are rooted at the fixed canonical path');
  assert.match(js, /function starCradleAssetUrl\(relativePath\) \{\s*\n\s*return `\$\{STAR_CRADLE_ASSET_ROOT\}\/\$\{relativePath\}`;\s*\n\s*\}/, 'the asset URL helper has no fallback / existence-check branch');
  assert.match(js, /const STAR_CRADLE_PLANT_STAGE_SPRITE = Object\.freeze\(\{ '芽': 'plant_sprout', '若葉': 'plant_leaf', '蕾': 'plant_bud' \}\);/, 'the pre-bloom plant stage sprites match the fixed 規約 names');
  // Sprite img src is set directly (a missing file surfaces as a load failure — no fallback src / onerror).
  assert.match(js, /img\.src = url;/, 'the sprite image src is set directly (load failure surfaces the missing asset)');
  assert.doesNotMatch(js.match(/function starCradleSpriteFigure\([\s\S]*?\n\}/)?.[0] ?? '', /onerror|\?\?\s*'\/canonical/, 'the sprite figure has no onerror / fallback src');
});

test('star cradle: entrance + overlay + garden CSS consume --routing-* tokens and animate reduced-motion-aware (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The golden accent is declared as --routing-gold* on the hub token block (no literal color pin at the
  // consumer) alongside the existing night/silver/starlight layer.
  const screenBlock = cssRuleBlock(css, '.routing-hub-screen');
  assert.match(screenBlock, /--routing-gold:\s*#ffe6a0;/, 'the hub token block declares the golden accent');
  assert.match(screenBlock, /--routing-gold-glow:\s*rgb\(255 214 120 \/ 0\.55\);/, 'the hub token block declares the golden glow');

  // The entrance is the drifting 天球儀 decor (decor-1) promoted above the frame: its position + drift come from
  // the shared .routing-hub-decor / .routing-hub-decor-1 rules (no bespoke float), and the globe button rule adds
  // only z-index (to sit above the frame so it can take clicks) + a --routing-* hover/focus glow.
  assert.match(css, /\.routing-hub-decor \{[^}]*animation:\s*routing-hub-drift/, 'the globe entrance reuses the shared decor drift');
  assert.match(css, /\.routing-hub-decor-1 \{[^}]*right:\s*57%[^}]*bottom:\s*58%[^}]*\}/, 'the globe entrance keeps the shared decor-1 position');
  const globe = cssRuleBlock(css, '.routing-hub-cradle-globe');
  assert.match(globe, /z-index:\s*4;/, 'the globe entrance sits above the frame so it can take clicks');
  assert.match(globe, /cursor:\s*pointer;/, 'the globe entrance shows a pointer affordance');
  assert.match(css, /\.routing-hub-cradle-globe:hover,\s*\n\s*\.routing-hub-cradle-globe:focus-visible \{[\s\S]*?var\(--routing-glow\)/, 'the hover/focus affordance consumes a --routing-* glow');
  assert.match(css, /\.routing-hub-cradle-globe:focus-visible \{[\s\S]*?outline:[^;]*var\(--routing-starlight\)/, 'the focus-visible ring consumes a --routing-* color');

  // The overlay card + garden consume --routing-* tokens; the golden effect + badge consume --routing-gold*.
  const card = cssRuleBlock(css, '.routing-hub-star-cradle-card');
  assert.match(card, /background:\s*var\(--routing-panel-strong\)/, 'the overlay card consumes a --routing-* fill');
  assert.match(css, /\.routing-hub-star-cradle-sprite\.is-golden \.routing-hub-star-cradle-sprite-img \{[\s\S]*?var\(--routing-gold-glow\)/, 'the golden plant effect consumes the golden glow token');
  const badge = cssRuleBlock(css, '.routing-hub-star-cradle-badge');
  assert.match(badge, /var\(--routing-gold\)/, 'the golden badge consumes the golden token');

  // The plant sway + creature wander animations exist and are disabled under reduced motion; the globe entrance's
  // drift stops through the shared .routing-hub-decor reduced-motion rule — the shared loop/academy/dungeon layers
  // are not touched.
  assert.match(css, /@keyframes routing-hub-star-cradle-sway/, 'the plant sway keyframes exist');
  assert.match(css, /@keyframes routing-hub-star-cradle-wander/, 'the creature wander keyframes exist');
  assert.match(css, /\.routing-hub-star-cradle-sprite-plant,\s*\n\s*\.routing-hub-star-cradle-sprite-creature \{\s*\n\s*animation: none;/, 'the plant sway + creature wander are disabled under reduced motion');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.routing-hub-decor,[\s\S]*?animation: none;/, 'the globe entrance drift stops under reduced motion via the shared decor rule');

  // No literal color in the new star cradle consumer rules (globe entrance → garden → sections): the golden hex
  // and the garden-veil rgb() live only in the .routing-hub-screen token declaration block. The guard forbids raw
  // hex AND raw rgb()/hsl() so an alpha-variant literal (like the garden veil) can't slip past a hex-only check.
  const cradleRules = css.match(/\.routing-hub-cradle-globe \{[\s\S]*?(?=\n\/\* ── Errand arrival screen)/)?.[0] ?? '';
  assert.notEqual(cradleRules, '', 'the star cradle CSS block is present');
  assert.doesNotMatch(cradleRules, /#[0-9a-fA-F]{3,6}\b/, 'the star cradle rules pin no literal hex color (tokens only)');
  assert.doesNotMatch(cradleRules, /\brgb\(|\brgba\(|\bhsl\(|\bhsla\(/, 'the star cradle rules pin no raw rgb()/hsl() color (tokens only — alpha variants go in the token block)');
});
