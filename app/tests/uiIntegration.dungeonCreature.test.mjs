import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('sanrin companion screen surfaces the encountered creature from the field payload without mixing academy and creature pools', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The Sanrin creature is resolved from the enriched /api/field payload
  // (currentField.state.creature_encounter.creature_summary), never the academy
  // roster and never the raw /api/state encounter: /api/state returns the persisted
  // runtime_state.json, which has no creature_summary, so reading currentRuntimeState
  // here would always miss it and the creature would never appear.
  const encounterSummaryFn = js.match(/function availableCreatureEncounterSummary\(\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(encounterSummaryFn, '', 'availableCreatureEncounterSummary should exist');
  assert.match(encounterSummaryFn, /currentField\?\.state\?\.creature_encounter/, 'creature candidate must read the enriched /api/field payload (currentField.state.creature_encounter)');
  assert.doesNotMatch(encounterSummaryFn, /currentRuntimeState\?\.creature_encounter/, 'creature candidate must not read the raw /api/state encounter, which lacks creature_summary');
  assert.match(encounterSummaryFn, /encounter\.status !== 'available'/, 'creature candidate requires an available encounter status');
  assert.match(encounterSummaryFn, /encounter\.creature_summary/, 'creature candidate reads the backend-provided creature_summary');

  // display_name / kind_label / visual_set / asset URL flow from the summary (authored profile + manifest via backend); never hardcoded client-side.
  const summaryBuilder = js.match(/function creatureCandidateFromSummary\(summary\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(summaryBuilder, '', 'creature candidate builder should exist');
  assert.match(summaryBuilder, /display_name: summary\.display_name/, 'creature display name must come from the summary, not a client-side literal');
  assert.match(summaryBuilder, /visual_set_id: visualSetId/, 'creature visual set id must come from the summary (id-unified creature_NNN)');
  assert.match(summaryBuilder, /const faceUrl = String\(summary\.face_url \?\? ''\)\.trim\(\)/, 'creature face should use the backend-provided manifest-backed URL');
  assert.match(summaryBuilder, /const standeeUrl = String\(summary\.standee_url \?\? ''\)\.trim\(\)/, 'creature standee should use the backend-provided manifest-backed URL');
  assert.match(summaryBuilder, /standee_url: standeeUrl/, 'creature standee should not be assembled client-side from an assumed extension');
  assert.doesNotMatch(summaryBuilder, /scene_standee_character_01\.jpg/, 'creature standee should not hardcode the current JPG extension');
  assert.match(summaryBuilder, /is_creature: true/, 'creature candidate should be flagged so academy-only rendering can branch');
  // Creatures carry academy-style stats; the candidate must take parameters and the
  // attitude type from the backend summary and fail fast (never zero-fill) if absent.
  assert.match(summaryBuilder, /parameters: summary\.parameters/, 'creature candidate must take parameters from the backend summary');
  assert.match(summaryBuilder, /parameter_attitude_type: parameterAttitudeType/, 'creature candidate must take the attitude type from the backend summary');
  assert.match(summaryBuilder, /missing creature summary parameters/, 'creature candidate must fail fast when parameters are missing instead of zero-filling');
  assert.match(summaryBuilder, /missing creature summary parameter_attitude_type/, 'creature candidate must fail fast when the attitude type is missing');

  // activeCharacter resolves the current creature candidate so conversation name/standee/face render for creatures.
  assert.match(js, /function activeCharacter\(\)[\s\S]*creatureActorById\(activeCharacterId\)/, 'activeCharacter should resolve the current creature candidate instead of falling back to an academy character');

  // Region-aware "who is at this stage" selection lives in one shared helper so the map hover popup
  // and the conversation-partner popup reuse the exact same mechanism (no per-map branch is duplicated).
  assert.match(js, /function stageOccupantsFor\(location\)[\s\S]*mapLocationRegion\(location\) === 'sanrin'[\s\S]*\? sanrinCreatureCandidatesFor\(location\.id\)[\s\S]*: assignedAcademyMapCharactersFor\(location\.id\)/, 'sanrin stages list creature candidates while academy stages keep their assigned academy characters, in one shared occupants helper');
  // The conversation-partner popup branches by region for its empty-state copy but takes its candidates from the shared helper.
  const companionPopup = js.match(/function renderAcademyMapCompanionPopup\(locationId = academyCompanionLocationId\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(companionPopup, '', 'conversation-partner popup renderer should exist');
  assert.match(companionPopup, /mapLocationRegion\(location\) === 'sanrin'/, 'the popup should detect sanrin stages');
  assert.match(companionPopup, /const candidates = stageOccupantsFor\(location\)/, 'the popup should take its candidates from the shared stage-occupants helper instead of an inline per-map branch');
  assert.match(companionPopup, /character\.is_creature/, 'creature cards should render distinctly from academy cards');

  // Creatures now carry the same magic/ability stats as students and render identical
  // meters; the renderer no longer special-cases creatures into an empty parameter area.
  // The two meter groups come from the shared buildParameterGroups builder (also used by the
  // player-parameter renderer and the routing hub self / buddy panels).
  const renderParamsInto = js.match(/function renderCharacterParametersInto\(character, containerSelector\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(renderParamsInto, '', 'parameter renderer should exist');
  assert.doesNotMatch(renderParamsInto, /is_creature/, 'creatures should no longer be special-cased into an empty parameter area');
  assert.match(renderParamsInto, /container\.replaceChildren\(\.\.\.buildParameterGroups\(character\.parameters\)\)/, 'creatures and students share the meter rendering through the shared parameter-group builder');
  const buildGroups = js.match(/function buildParameterGroups\(parameters = \{\}\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(buildGroups, '', 'the shared parameter-group builder should exist');
  assert.match(buildGroups, /renderParameterGroup\('魔法習熟度', magicParameterDefinitions, parameters\.magic\)/, 'the shared builder renders the magic meter group');
  assert.match(buildGroups, /renderParameterGroup\('基礎能力', abilityParameterDefinitions, parameters\.abilities\)/, 'the shared builder renders the ability meter group');

  // Ungenerated creature visual sets degrade gracefully instead of breaking the layout.
  assert.match(js, /function hideImageOnError\(image\)[\s\S]*image\.style\.visibility = 'hidden'/, 'a missing creature image should hide instead of breaking the layout');
});

test('creature conversation start keeps the creature actor across refresh and sends the chosen creature id to the opening (no reset to character_001 / セラ)', async () => {
  const js = await readFile(path.join(projectRoot, 'app/public/app.js'), 'utf8');

  function functionSource(name) {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  }

  // The positive creature signal: an out-of-roster active actor is a creature only when it
  // resolves through creatureActorById (registered candidate or live encounter), never by
  // silently keeping an unidentified id.
  assert.match(js, /function isCreatureActorId\(characterId\)[\s\S]*?creatureActorById\(characterId\)/,
    'a creature-actor predicate must exist and resolve through creatureActorById');

  // 1. refreshCharacters() must not hijack a creature conversation (or a live routing hub / 錬成室
  //    conversation): the academy-roster fallback (reset to selectableCharacters[0] = character_001) is
  //    gated behind the single non-selectable-actor predicate, and the fallback itself is retained for
  //    unknown academy ids. The predicate resolves a creature through isCreatureActorId.
  const refreshChars = functionSource('refreshCharacters');
  assert.match(refreshChars, /if\s*\(!isNonSelectableActiveActorId\(activeCharacterId\)\)\s*\{\s*activeCharacterId = selectableCharacters\[0\]\?\.character_id/,
    'the reset to the academy roster head must be skipped when the active actor is non-selectable (creature / routing persona / homunculus)');
  assert.match(functionSource('isNonSelectableActiveActorId'), /isCreatureActorId\(characterId\)/,
    'the single non-selectable-actor predicate resolves a creature through isCreatureActorId');

  // 2. The opening targets the explicitly chosen id, decoupled from the global that refresh
  //    may have rewritten — both the streamed and non-streamed opening paths.
  const ensureOpening = functionSource('ensureOpeningUtterance');
  assert.match(ensureOpening, /ensureOpeningUtterance\(\{ characterId = activeCharacterId/,
    'ensureOpeningUtterance must accept an explicit characterId (defaulting to the global)');
  assert.match(ensureOpening, /runOpeningConversationStream\(\{ characterId, provider/,
    'the streamed opening must forward the chosen characterId');
  assert.match(ensureOpening, /postJson\('\/api\/conversation\/opening', \{ character_id: characterId/,
    'the non-streamed opening must send the chosen characterId');

  const runOpening = functionSource('runOpeningConversationStream');
  assert.match(runOpening, /body: \{ character_id: characterId, provider: provider \}/,
    'the opening stream body must send the chosen characterId');
  assert.doesNotMatch(runOpening, /character_id: activeCharacterId/,
    'the opening stream body must not hardcode the global activeCharacterId');

  // 3. The companion→conversation entry hands the chosen id through refresh to the opening.
  const companionStart = functionSource('startAcademyConversationSessionFromCompanion');
  assert.match(companionStart, /ensureOpeningUtterance\(\{ characterId, onAssistantStreamStart: markOpeningStreamStarted \}\)/,
    'the companion conversation entry must pass the chosen characterId to the opening');
});

test('dungeon menu close control is a proper token-styled button consistent with the HUD buttons', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  // The menu popup close uses the shared dungeon icon button. The conversation panel is
  // always on, so it has no close control of its own.
  assert.doesNotMatch(html, /id="dungeon-chat-close"/, 'the always-on conversation panel has no close button');
  assert.match(html, /id="dungeon-popup-close"[^>]*class="dungeon-icon-button"/, 'the menu popup close should use the shared dungeon icon button');

  // test-by-token: the close button consumes the shared design tokens, not a floating one-off style.
  const block = cssRuleBlock(css, '.dungeon-icon-button');
  assert.match(block, /border:\s*1px solid var\(--dungeon-line\)/, 'close button should use the dungeon amber hairline border token');
  assert.match(block, /background:\s*var\(--dungeon-chip\)/, 'close button should use the dungeon obsidian chip surface token');
  assert.match(block, /color:\s*var\(--dungeon-ink-strong\)/, 'close button should use the dungeon ivory ink token');
  assert.match(block, /align-items:\s*center/, 'close glyph should be centered like a proper button');
  assert.match(block, /justify-content:\s*center/, 'close glyph should be centered like a proper button');
  assert.match(block, /transition:/, 'close button should animate its interaction like the other dungeon buttons');
  assertNoCoolOrSoftBorderToken(block, 'dungeon close icon button');

  // Interaction states consistent with .dungeon-hud-button (same dungeon-screen button family).
  assert.match(css, /\.dungeon-icon-button:hover\s*\{[^}]*box-shadow:[^}]*var\(--dungeon-lift\)/, 'close button hover should lift with the dungeon obsidian lift shadow token');
  assert.match(css, /\.dungeon-icon-button:active\s*\{[^}]*background:\s*var\(--dungeon-inset\)/, 'close button active should use the dungeon obsidian inset surface token');
});

test('dungeon run-end (踏破 / 撤退 / 全滅) floats one result popup over the still-visible board — no surface swap, no screen-replace card, one content builder, 踏破 reads as a 祝勝 (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  // MARKUP: the single result popup lives inside the dungeon screen (so the id-scoped
  // `#academy-dungeon-screen [hidden]` guard hides it), reuses the dungeon popup overlay + panel
  // surface classes, is a modal dialog, starts hidden, and carries no literal color/close button
  // (it is a transient auto-advancing beat for every outcome, not an interactive menu popup).
  const dungeonScreen = html.match(/<section id="academy-dungeon-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(dungeonScreen, /id="dungeon-result-popup"/, 'the result popup must live inside the dungeon screen so the screen-scoped [hidden] guard covers it');
  // The old screen-replace end card is gone with no trace — only entry / play surfaces + overlays remain.
  assert.doesNotMatch(dungeonScreen, /id="dungeon-result"/, 'the screen-replace #dungeon-result end card surface is removed entirely (踏破/撤退 no longer swap surfaces)');
  const popupEl = html.match(/<div id="dungeon-result-popup"[\s\S]*?<div id="dungeon-result-popup-body"[^>]*><\/div>\s*<\/div>\s*<\/div>/)?.[0] ?? '';
  assert.match(popupEl, /class="dungeon-popup dungeon-result-popup"/, 'the result popup reuses the shared dungeon popup overlay class (fixed inset backdrop)');
  assert.match(popupEl, /\bhidden\b/, 'the result popup starts hidden');
  assert.match(popupEl, /role="dialog"[\s\S]*?aria-modal="true"/, 'the result popup is a modal dialog');
  assert.match(popupEl, /aria-labelledby="dungeon-result-popup-title"/, 'the result popup names itself from its rendered heading id (resolves for all 3 outcomes)');
  assert.match(popupEl, /class="dungeon-popup-panel app-card dungeon-result-popup-panel"/, 'the result popup panel reuses the shared dungeon popup panel + app-card surface');
  assert.doesNotMatch(popupEl, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the result popup markup pins no literal color (surface comes from reused tokens)');
  assert.doesNotMatch(popupEl, /<button/, 'the result popup is a transient auto-advancing beat with no manual close button');

  // BEHAVIOR: renderDungeonResult is ONE path for all three outcomes — it floats the popup over the board
  // and NEVER hides #dungeon-play or #dungeon-chat (so nothing reflows and the camera never reframes) and
  // NEVER references the removed screen-replace card. Only the entry card is force-hidden.
  const fn = js.match(/function renderDungeonResult\(result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fn, '', 'renderDungeonResult is present');
  assert.doesNotMatch(fn, /if \(result\.status === 'dead'\)/, 'the result render no longer branches per outcome — a single popup path serves 踏破/撤退/全滅');
  assert.doesNotMatch(fn, /#dungeon-play'\)\.hidden = true/, 'no outcome hides the play surface — the board stays visible under the popup (画面遷移しない)');
  assert.doesNotMatch(fn, /#dungeon-chat'\)\.hidden = true/, 'no outcome hides the chat aside — hiding it would reflow the board / reframe the camera');
  assert.doesNotMatch(fn, /#dungeon-result'/, 'the removed screen-replace card is never referenced');
  assert.match(fn, /#dungeon-entry'\)\.hidden = true/, 'only the entry card is force-hidden so it can never coexist with the popup');
  assert.match(fn, /#dungeon-result-popup-body'\)\.replaceChildren\(\.\.\.buildDungeonResultNodes\(result\)\)/, 'the result content mounts into the popup body via the single shared builder');
  assert.match(fn, /#dungeon-result-popup'\)\.hidden = false/, 'the popup is shown over the board for every outcome');

  // Single source of the result info AND the single mount site: exactly one surface consumes the builder,
  // so heading / floor / gains can never drift. The builder carries the outcome tone (eyebrow + heading),
  // reads 踏破 as a 祝勝 (「ダンジョン制覇」), sets the popup heading id its aria-labelledby resolves to,
  // and marks the heading with data-status so the stylesheet can tone the cleared victory accent.
  const mountSites = js.match(/replaceChildren\(\.\.\.buildDungeonResultNodes/g) ?? [];
  assert.equal(mountSites.length, 1, 'exactly one result surface mounts the shared builder — the popup (no second card path)');
  assert.match(js, /function buildDungeonResultNodes\(result\) \{[\s\S]*?const eyebrows = \{ retreated: 'Retreat', cleared: 'Dungeon Cleared', dead: 'Defeat' \};[\s\S]*?const headings = \{ retreated: '撤退しました', cleared: 'ダンジョン制覇', dead: '力尽きました' \};[\s\S]*?title\.id = 'dungeon-result-popup-title';[\s\S]*?title\.dataset\.status = result\.status;/, 'the single builder holds the per-outcome eyebrows + headings (踏破 = 祝勝 「ダンジョン制覇」), labels the heading id, and marks the heading status');
  assert.match(js, /const nodes = \[eyebrow, title, summary, gains\];[\s\S]*?const materials = buildDungeonResultMaterials\(result\.materials\);[\s\S]*?if \(materials\) nodes\.push\(materials\);[\s\S]*?return nodes;/, 'the builder assembles the eyebrow/heading/floor/gains lines then appends the run-end materials section when the run picked any up');
  // Fail-fast, not a default-value fallback (absolute rules): an out-of-contract status throws instead of
  // painting a generic eyebrow/heading label.
  const builder = js.match(/function buildDungeonResultNodes\(result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(builder, /if \(!\(result\.status in headings\)\) throw new Error/, 'the builder fails fast on an unknown status');
  assert.doesNotMatch(builder, /\?\?\s*'Result'|\?\?\s*'探索終了'/, 'no default-value fallback label remains for an unknown status');

  // EXIT HAND-OFF UNCHANGED: an ended run still renders the result then hands off to dungeonExitToRoom,
  // so the change is presentation-only — the return screen / finalize path is byte-equivalent per outcome.
  assert.match(js, /if \(result\.ended\) \{[\s\S]*?renderDungeonResult\(result\);\s*\n\s*await dungeonExitToRoom\(result\);/, 'the ended-run path renders the result then auto-advances via dungeonExitToRoom (return/finalize contract unchanged)');

  // The popup re-hides on every re-entry / replay so a stale result popup never lingers over a new run.
  assert.match(js, /function renderDungeonEntry\(\)[\s\S]*?#dungeon-result-popup'\)\.hidden = true/, 'the entry render clears any leftover result popup');
  assert.match(js, /function renderDungeonPlay\(view\)[\s\S]*?#dungeon-result-popup'\)\.hidden = true/, 'the play render clears any leftover result popup before showing a board');

  // STYLE (test-by-token): the popup body/panel consume dungeon obsidian+amber tokens, no literal pin. The
  // panel centres its run-end content and carries an amber inner ring; the 踏破 (cleared) victory accent —
  // an amber hairline + lamplight glow — is keyed declaratively off the builder's data-status heading marker.
  assert.match(css, /\.dungeon-result-popup-body\s*\{[^}]*display:\s*flex/, 'the result popup body stacks its lines');
  assert.match(css, /\.dungeon-result-popup-body h3\s*\{[^}]*color:\s*var\(--dungeon-ink-strong\)/, 'the popup heading uses the dungeon ivory ink-strong token');
  assert.match(css, /\.dungeon-result-popup-body p\s*\{[^}]*color:\s*var\(--dungeon-ink\)/, 'the popup body text uses the dungeon ivory ink token');
  assert.doesNotMatch(css.match(/\.dungeon-result-popup-body\s*\{[^}]*\}/)?.[0] ?? '', /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the result popup body pins no literal color');
  assert.match(css, /\.dungeon-result-popup-panel\s*\{[^}]*text-align:\s*center/, 'the result popup panel centres its run-end content');
  assert.match(css, /\.dungeon-result-popup-panel\s*\{[^}]*box-shadow:[^}]*var\(--dungeon-inner-ring\)/, 'the result popup panel carries the obsidian amber inner ring');
  assert.match(css, /\.dungeon-result-popup-panel:has\(h3\[data-status="cleared"\]\)\s*\{[^}]*border-color:\s*var\(--dungeon-amber\)/, 'the 踏破 popup carries the amber victory hairline (keyed off the cleared heading marker)');
  assert.match(css, /\.dungeon-result-popup-panel:has\(h3\[data-status="cleared"\]\)\s*\{[^}]*box-shadow:[^}]*var\(--dungeon-glow\)/, 'the 踏破 popup adds the amber lamplight victory glow');
  assert.match(css, /\.dungeon-result-popup-panel:has\(h3\[data-status="cleared"\]\) h3\s*\{[^}]*color:\s*var\(--dungeon-amber\)/, 'the 踏破 heading burns amber (祝勝), set apart from the calmer 撤退 / 全滅 tone');
  assert.doesNotMatch(css.match(/\.dungeon-result-popup-panel:has\(h3\[data-status="cleared"\]\)\s*\{[^}]*\}/)?.[0] ?? '', /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the cleared victory accent pins no literal color');
  // The screen-scoped [hidden] guard (which hides the popup despite .dungeon-popup display:flex) exists.
  assert.match(css, /#academy-dungeon-screen \[hidden\]\s*\{\s*display:\s*none;?\s*\}/, 'the dungeon screen keeps its id-scoped [hidden] guard so the display:flex popup hides when toggled');

  // RUN-END MATERIALS: under the gains line the popup lists the run's 持ち帰った / 失った素材. The manifest is
  // contractually required — a missing/mis-shaped one fails fast (never silently skipped); an empty pickup
  // renders no section (a legitimate 拾わなかった run). retained=true reads as 持ち帰った, retained=false (敗北)
  // as 失った — the same items, marked with data-retained so the stylesheet tones the loss distinctly. The
  // run-end items carry only display_name + quantity (no element/tier).
  const materialsFn = js.match(/function buildDungeonResultMaterials\(materials\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(materialsFn, '', 'buildDungeonResultMaterials is present');
  assert.match(materialsFn, /throw new Error\(`dungeon result requires a materials object/, 'a missing/non-object materials manifest fails fast (contractually required)');
  assert.match(materialsFn, /throw new Error\(`dungeon result materials requires a boolean retained/, 'a non-boolean retained fails fast');
  assert.match(materialsFn, /throw new Error\(`dungeon result materials requires an items array/, 'a non-array items list fails fast');
  assert.match(materialsFn, /if \(materials\.items\.length === 0\) return null;/, 'an empty pickup renders no section (legitimate 拾わなかった, not a masked fallback)');
  assert.match(materialsFn, /section\.dataset\.retained = String\(materials\.retained\);/, 'the section marks retained so the stylesheet can tone the 敗北 loss distinctly');
  assert.match(materialsFn, /heading\.textContent = materials\.retained \? '持ち帰った素材' : '失った素材';/, '持ち帰り reads 持ち帰った素材, the 敗北 loss reads 失った素材 (same items, toned as a loss)');
  assert.match(materialsFn, /throw new Error\(`dungeon result material requires a non-empty display_name/, 'a material row fails fast on a missing/empty server-authored display_name');
  assert.match(materialsFn, /throw new Error\(`dungeon result material requires a numeric quantity/, 'a material row fails fast on a non-numeric quantity');
  assert.doesNotMatch(materialsFn, /\?\?\s*\[\]|\?\?\s*\{\}/, 'no silent/default fallback masks a broken materials manifest');

  // STYLE (test-by-token): the materials block consumes the dungeon obsidian+amber token layer with no literal
  // color; the 敗北 loss tone (danger heading + struck-through dim name) keys off the data-retained marker.
  assert.match(css, /\.dungeon-result-materials \{[^}]*border-top:\s*1px solid var\(--dungeon-line\)/, 'the materials block sits under a dungeon hairline (token, not a literal)');
  assert.match(css, /\.dungeon-result-materials-heading \{[^}]*color:\s*var\(--dungeon-amber\)/, 'the 持ち帰り heading burns the amber accent');
  assert.match(css, /\.dungeon-result-materials-name \{[^}]*color:\s*var\(--dungeon-ink\)/, 'a kept material name reads in the ivory ink token');
  assert.match(css, /\.dungeon-result-materials-quantity \{[^}]*color:\s*var\(--dungeon-ink-dim\)/, 'the quantity reads in the dim ink token');
  assert.match(css, /\.dungeon-result-materials\[data-retained="false"\] \.dungeon-result-materials-heading \{[^}]*color:\s*var\(--dungeon-danger\)/, 'the 敗北 loss heading switches to the danger token');
  assert.match(css, /\.dungeon-result-materials\[data-retained="false"\] \.dungeon-result-materials-name \{[^}]*text-decoration:\s*line-through/, 'the lost material names are struck through so a lost pickup reads apart from a kept one');
  const materialsCss = (css.match(/\.dungeon-result-materials[^{]*\{[^}]*\}/g) ?? []).join('\n');
  assert.notEqual(materialsCss, '', 'the materials block CSS is present');
  assert.doesNotMatch(materialsCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the materials block pins no literal color (all dungeon tokens)');
});

test('inventory 素材メタ表示: dungeon-material items (element+tier) render 属性/T<tier> badges across the four item-ledger surfaces; non-materials render unchanged; the shared builder fails fast on a broken pair (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The shared builder: decorateInventory exposes element (6-attr) + tier (1..4) on dungeon materials ONLY, as
  // a pair; a non-material exposes NEITHER (a legitimate "not a material" → null, unchanged render, not a
  // fallback). A half-present pair or an out-of-range tier is a broken enrich contract and surfaces. The 属性
  // label reuses the shared fail-fast workshopElementLabel vocabulary.
  const metaFn = js.match(/function buildInventoryMaterialMeta\(item, className\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(metaFn, '', 'buildInventoryMaterialMeta is present');
  assert.match(metaFn, /if \(!hasElement && !hasTier\) return null;/, 'an item with neither field is not a material and renders unchanged (null, no badges)');
  assert.match(metaFn, /if \(hasElement !== hasTier\) \{[\s\S]*?throw new Error/, 'a half-present element/tier pair fails fast (broken enrich contract, not silently rendered)');
  assert.match(metaFn, /if \(!Number\.isInteger\(item\.tier\) \|\| item\.tier < 1 \|\| item\.tier > 4\) \{[\s\S]*?throw new Error/, 'a tier outside 1..4 fails fast');
  assert.match(metaFn, /element\.textContent = `属性\$\{workshopElementLabel\(item\.element\)\}`;/, 'the badge shows 属性<label> via the shared fail-fast element vocabulary');
  assert.match(metaFn, /tier\.textContent = `T\$\{item\.tier\}`;/, 'the badge shows T<tier>');
  assert.doesNotMatch(metaFn, /item\.element \?\?|item\.tier \?\?/, 'no default-value fallback masks a missing element/tier');

  // Each of the four item-ledger surfaces (自室 / 学院マップ夜ドロワー / routing hub ドロワー / conversation-day
  // ドロワー) appends the badges through the shared builder with its own surface-scoped class, and only when the
  // item is a material (row.append is guarded on a non-null return, so non-materials render byte-identically).
  for (const [fnName, className] of [
    ['renderAcademyRoomInventoryItems', 'academy-room-item-materia'],
    ['renderAcademyMapInventoryInfo', 'academy-map-info-ledger-materia'],
    ['renderRoutingHubInventoryLedgerInto', 'routing-hub-info-ledger-materia'],
    ['renderConversationDayInventoryInto', 'conversation-day-info-ledger-materia']
  ]) {
    const fn = js.match(new RegExp(`function ${fnName}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert.notEqual(fn, '', `${fnName} is present`);
    assert.match(fn, new RegExp(`const materialMeta = buildInventoryMaterialMeta\\(item, '${className}'\\);`), `${fnName} builds the material badges with its surface-scoped class`);
    assert.match(fn, /if \(materialMeta\) row\.append\(materialMeta\);/, `${fnName} appends the badges only for a material item`);
  }

  // STYLE: each surface tones the badges in its own token layer. The three metaphysical/night surfaces pin no
  // literal color (strict token consumption); the room reuses its --c-gold token layer (the same gold its row
  // hover already reads) and pins no raw hex.
  for (const cls of ['academy-map-info-ledger-materia', 'routing-hub-info-ledger-materia', 'conversation-day-info-ledger-materia']) {
    const rule = css.match(new RegExp(`\\.${cls} span \\{[^}]*\\}`))?.[0] ?? '';
    assert.notEqual(rule, '', `.${cls} span rule is present`);
    assert.match(rule, /border:\s*1px solid var\(--[a-z-]+\)/, `.${cls} badges border reads a surface token`);
    assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, `.${cls} badges pin no literal color (surface token layer only)`);
  }
  const roomRule = css.match(/\.academy-room-item-materia span \{[^}]*\}/)?.[0] ?? '';
  assert.notEqual(roomRule, '', '.academy-room-item-materia span rule is present');
  assert.match(roomRule, /var\(--c-gold\)/, 'the room badges consume the --c-gold token layer (the row-hover gold)');
  assert.doesNotMatch(roomRule, /#[0-9a-fA-F]{3,6}\b/, 'the room badges pin no raw hex literal');
});

test('dungeon obsidian restyle: dedicated 黒曜+琥珀 --dungeon-* token layer, board-protection preserved, gameplay signal colors kept distinguishable, no old shared-chrome tokens (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The whole practical-dungeon CSS section (its header comment up to the next screen's section header).
  const section = css.match(/\/\* ===== Practical dungeon[\s\S]*?\n\/\* ── Routing hub screen/)?.[0] ?? '';
  assert.notEqual(section, '', 'the practical dungeon CSS section should exist');

  // Dedicated obsidian+amber token layer scoped to the screen — NOT borrowed from the other screens' layers
  // (the conversation-day 黒夜 vocabulary, self-declared like 調合 / 鍛錬).
  const scopeCss = cssRuleBlock(css, '.dungeon-screen');
  assert.match(scopeCss, /--dungeon-bg-0:[\s\S]*--dungeon-ink:[\s\S]*--dungeon-amber:/, 'the dungeon screen declares its own obsidian / ink / amber token layer');
  assert.match(scopeCss, /color:\s*var\(--dungeon-ink\)/, 'the obsidian scope reads its base text off the ink token');
  assert.doesNotMatch(scopeCss, /--routing-|--cd-|--alchemy-|--training-|--errand-|--meta-/, 'the dungeon token layer does not redefine or borrow the other screens token layers');

  // Destructive removal (test-by-token): no old shared-chrome color token is consumed anywhere in the
  // dungeon section — every chrome color now reads off --dungeon-*; shared --radius-* / --dn-* runtime
  // vars stay.
  assert.doesNotMatch(section, /var\(--c-(ink|gold|blue|cream|danger)\)/, 'no shared raw-channel color tokens remain in the dungeon section');
  assert.doesNotMatch(section, /var\(--surface-(panel|chip|inset|map-shell)\)/, 'no shared surface tokens remain in the dungeon section');
  assert.doesNotMatch(section, /var\(--border-warm(-soft)?\)/, 'no shared warm-gold border tokens remain in the dungeon section');
  assert.doesNotMatch(section, /var\(--text(-strong|-muted|-enemy|-cool-strong)?\)/, 'no shared text tokens remain in the dungeon section');
  assert.doesNotMatch(section, /var\(--eyebrow\)|var\(--accent-gold\)/, 'no shared eyebrow / accent-gold tokens remain in the dungeon section');
  assert.doesNotMatch(section, /var\(--shadow-(map-shell|academy-training-panel)\)/, 'no shared shadow tokens remain in the dungeon section');

  // Literal colors live ONLY in the .dungeon-screen declaration block. Everything after the scope's base
  // `color` line (i.e. every consuming rule) is var(--dungeon-*) with no literal color pin.
  const afterScope = section.slice(section.indexOf('color: var(--dungeon-ink);'));
  assert.doesNotMatch(afterScope, /#[0-9a-fA-F]{3,6}\b/, 'no literal hex colors are consumed outside the dungeon token declaration block');
  assert.doesNotMatch(afterScope, /rgb\(/, 'no literal rgb() colors are consumed outside the dungeon token declaration block');

  // The screen is the obsidian ground filling the layout edge-to-edge (direct-background standard, no map-shell,
  // no floating-frame chrome that would read as a window on the body's navy gradient).
  const frameCss = cssRuleBlock(css, '#academy-dungeon-screen.active');
  assert.match(frameCss, /background:\s*var\(--dungeon-bg-0\)/, 'the dungeon screen paints the obsidian ground');
  assert.doesNotMatch(frameCss, /border:|border-radius:|box-shadow:/, 'the dungeon screen is edge-to-edge obsidian with no floating-frame border / radius / shadow chrome');

  // The entry / popup surfaces (shared .app-card in markup) wear the obsidian panel skin in-scope,
  // id-scoped so the shared .app-card stays byte-equal. The entry eyebrow recolors to amber lamplight in-scope.
  assert.match(css, /#academy-dungeon-screen \.dungeon-entry,\s*\n#academy-dungeon-screen \.dungeon-popup-panel\s*\{[^}]*background:\s*var\(--dungeon-panel\)/, 'the entry / popup surfaces wear the obsidian panel token (shared .app-card untouched)');
  assert.match(css, /#academy-dungeon-screen \.dungeon-entry,\s*\n#academy-dungeon-screen \.dungeon-popup-panel\s*\{[^}]*border:\s*1px solid var\(--dungeon-line\)/, 'the entry / popup surfaces carry the amber hairline');
  assert.match(css, /#academy-dungeon-screen \.eyebrow\s*\{\s*color:\s*var\(--dungeon-amber\)/, 'the dungeon eyebrow is amber lamplight in-scope (shared .eyebrow stays byte-equal)');

  // Inner play panels (HUD / grid / dock / chat) adopt the obsidian panel + amber hairline.
  for (const sel of ['.dungeon-hud', '.dungeon-grid', '.dungeon-dock', '.dungeon-chat']) {
    const block = cssRuleBlock(css, sel);
    assert.match(block, /background:\s*var\(--dungeon-panel\)/, `${sel} adopts the obsidian panel surface token`);
    assert.match(block, /border:\s*1px solid var\(--dungeon-line\)/, `${sel} adopts the amber hairline border token`);
  }

  // Board-protection exception preserved: the camera-transformed .dungeon-grid keeps NO backdrop blur (the
  // map board renders untouched under the camera), unlike the other blurred panels.
  const gridCss = cssRuleBlock(css, '.dungeon-grid');
  assert.doesNotMatch(gridCss, /backdrop-filter/, 'the camera-transformed dungeon grid keeps no backdrop blur (board rendering untouched)');
  assert.match(cssRuleBlock(css, '.dungeon-hud'), /backdrop-filter:\s*blur/, 'the HUD panel keeps its blur (only the grid is exempt)');

  // Gameplay signal colors kept distinguishable — HP=danger→amber, MP=blue tokenized gradients, and the 6
  // element identity hues defined + consumed by both the map ring tint and the spell pill.
  assert.match(scopeCss, /--dungeon-hp-fill: linear-gradient\(90deg, rgb\(255 122 122 \/ 0\.9\), rgb\(240 178 74 \/ 0\.9\)\)/, 'the HP bar keeps its danger→amber identity gradient');
  assert.match(scopeCss, /--dungeon-mp-fill: linear-gradient\(90deg, rgb\(150 212 255 \/ 0\.6\), rgb\(150 212 255 \/ 0\.95\)\)/, 'the MP bar keeps its blue identity gradient');
  assert.match(css, /\.dn-hud-bar--hp \.dn-hud-bar-fill\s*\{[^}]*background:\s*var\(--dungeon-hp-fill\)/, 'the HP bar fill consumes the tokenized HP gradient');
  assert.match(css, /\.dn-hud-bar--mp \.dn-hud-bar-fill\s*\{[^}]*background:\s*var\(--dungeon-mp-fill\)/, 'the MP bar fill consumes the tokenized MP gradient');
  for (const el of ['light', 'dark', 'fire', 'water', 'earth', 'wind']) {
    assert.match(scopeCss, new RegExp(`--dungeon-el-${el}:`), `the ${el} element identity color is a token`);
    assert.match(css, new RegExp(`\\.dn-el-${el}\\s*\\{\\s*color:\\s*var\\(--dungeon-el-${el}\\)`), `the ${el} spell pill consumes its element identity token`);
    assert.match(css, new RegExp(`\\.dn-token--el-${el}\\s*\\{\\s*color:\\s*var\\(--dungeon-el-${el}\\)`), `the ${el} enemy ring consumes its element identity token`);
  }
  // The self-heal pill keeps the amber restore accent, distinct from the element spells.
  assert.match(css, /\.dungeon-spell-heal\s*\{\s*color:\s*var\(--dungeon-amber\)/, 'the self-heal pill keeps the amber restore accent, distinct from the element spells');
});

test('practical-dungeon entry equipment: two equip slots + run-correction breakdown, shared workshop vocabulary (no second label map), snapshot-authoritative equip/unequip, fail-fast, token-only (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // MARKUP: the equipment section is a pure addition to the entry surface (#dungeon-entry), before the play
  // surface. It carries a status live region (hidden by default — the error banner), the two-slot container the
  // slot cards render into, and the run-correction container. It reuses the shared .eyebrow (recolored amber in
  // the dungeon scope), NOT a new label chrome.
  assert.match(html, /id="dungeon-entry"[\s\S]*?id="dungeon-equipment"[\s\S]*?id="dungeon-play"/, 'the equipment section lives inside the entry surface (between the entry container and the play surface)');
  const equipBlock = html.match(/<div id="dungeon-equipment"[\s\S]*?<div id="dungeon-equipment-run"[^>]*><\/div>\s*<\/div>/)?.[0] ?? '';
  assert.notEqual(equipBlock, '', 'a #dungeon-equipment block should exist inside the entry surface');
  assert.match(equipBlock, /<p class="eyebrow">Equipment<\/p>/, 'the equipment section reuses the shared eyebrow (amber lamplight in the dungeon scope)');
  assert.match(equipBlock, /<p id="dungeon-equipment-status"[^>]*aria-live="polite" hidden>/, 'the equipment section carries a status live region, hidden by default (error banner only)');
  assert.match(equipBlock, /<div id="dungeon-equipment-targets"[^>]*role="tablist"/, 'the equipment section carries the 主人公/バディー target tablist (empty in the solo case, populated when a buddy is set)');
  assert.match(equipBlock, /<div id="dungeon-equipment-slots"/, 'the equipment section carries the two-slot container the slot cards render into');
  assert.match(equipBlock, /<div id="dungeon-equipment-run"/, 'the equipment section carries the run-correction breakdown container');

  // VOCABULARY: the equipment labels are the SAME closed sets the workshop consumes (workshopArrivalClient.js,
  // mirroring app/src/equipment.mjs) — imported, not re-declared. app.js defines NO private equipment label map.
  assert.match(js, /import \{[\s\S]*?WORKSHOP_EQUIPMENT_KINDS,[\s\S]*?WORKSHOP_EFFECT_KEYS,\s*\n\s*WORKSHOP_EFFECT_LABELS,[\s\S]*?workshopEffectEntries,[\s\S]*?workshopKindLabel,[\s\S]*?\} from '\.\/workshopArrivalClient\.js'/, 'app.js imports the shared equipment vocabulary + effect-entry helper from workshopArrivalClient.js');
  assert.doesNotMatch(js, /(EQUIPMENT_KIND_LABELS|EQUIPMENT_EFFECT_LABELS|EQUIPMENT_QUALITY_LABELS)\s*=/, 'app.js defines no private equipment label map (the workshop closed-set labels are the single source)');
  assert.match(js, /function dungeonEquipmentInstanceMetaText\(instance\)[\s\S]*?workshopKindLabelFull\(instance\)[\s\S]*?workshopElementLabel\(instance\.element\)[\s\S]*?workshopQualityLabel\(instance\.quality\)/, 'the instance identity line reads its 種別/属性/出来栄え off the shared closed-set label functions (fail-fast on an out-of-set value)');
  assert.match(js, /workshopEffectEntries\(instance\.base_effects, [^,]+, \{ allowEmpty: true \}\)/, 'base effects render through the shared effect-entry helper (allowEmpty — the instance-shape contract permits an empty set)');
  assert.match(js, /workshopEffectEntries\(instance\.bonus_effects, [^,]+, \{ allowEmpty: true \}\)/, 'bonus effects render through the shared effect-entry helper (allowEmpty → an honest 「なし」, never a silent skip)');

  // FETCH: the entry render fetches the snapshot (clear-before-load, fail closed), and a failure surfaces on the
  // equipment status line without failing the whole entry render.
  assert.match(js, /async function renderDungeonEntry\(\)[\s\S]*?await refreshDungeonEquipment\(\)\.catch\(reportDungeonEquipmentError\);/, 'the entry render loads the equipment snapshot and surfaces its failure on the equipment reporter (not the whole entry)');
  assert.match(js, /async function refreshDungeonEquipment\(\)[\s\S]*?clearDungeonEquipment\(\);[\s\S]*?getJson\('\/api\/equipment'\);[\s\S]*?renderDungeonEquipment\(snapshot\)/, 'the equipment refresh clears BEFORE fetching (fail closed) then renders GET /api/equipment');

  // FAIL-FAST: the whole snapshot is validated before any DOM — the two-slot map (a missing slot key), a non-array
  // instances, a malformed run_equipment, and the required buddy sub-view all throw (no silent skip / placeholder).
  const snapFn = js.match(/function validateDungeonEquipmentSnapshot\(snapshot\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(snapFn, '', 'validateDungeonEquipmentSnapshot should exist');
  assert.match(snapFn, /validateDungeonEquipmentSlots\(snapshot\.slots, 'slots'\)/, 'the player slots resolve through the shared slot validator');
  assert.match(snapFn, /if \(!Array\.isArray\(snapshot\.instances\)\)[\s\S]*?throw new Error/, 'a non-array instances is malformed → throw');
  assert.match(snapFn, /validateDungeonRunEquipment\(snapshot\.run_equipment\)/, 'run_equipment is validated fail-fast');
  assert.match(snapFn, /validateDungeonBuddyEquipment\(snapshot\.buddy\)/, 'the required buddy sub-view is validated fail-fast');
  // The player slots AND the buddy slots resolve through ONE shared slot validator: a missing slot key is malformed
  // (an absent key is not a silent null), and a present null is the ONLY unequipped reading.
  const slotsValFn = js.match(/function validateDungeonEquipmentSlots\(rawSlots, label\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(slotsValFn, '', 'validateDungeonEquipmentSlots should exist (shared by player + buddy)');
  assert.match(slotsValFn, /\$\{label\} is missing the \$\{slot\} slot/, 'a missing slot key is malformed → throw (an absent key is not a silent null)');
  assert.match(slotsValFn, /if \(value === null\) \{[\s\S]*?resolvedSlots\[slot\] = null;/, 'a present null slot is the ONLY unequipped reading');
  // The buddy sub-view: a missing (undefined) buddy is a broken server contract → throw; a null buddy is the valid
  // solo reading; a present buddy mirrors the player derivation through the SAME slot + run_equipment validators.
  const buddyValFn = js.match(/function validateDungeonBuddyEquipment\(buddy\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buddyValFn, '', 'validateDungeonBuddyEquipment should exist');
  assert.match(buddyValFn, /if \(buddy === undefined\) \{[\s\S]*?throw new Error/, 'a missing buddy key is a broken server contract → throw (not a silent solo)');
  assert.match(buddyValFn, /if \(buddy === null\) return null;/, 'a null buddy is the valid no-companion reading');
  assert.match(buddyValFn, /validateDungeonEquipmentSlots\(buddy\.slots, 'buddy\.slots'\)/, 'the buddy slots resolve through the SAME shared slot validator as the player');
  assert.match(buddyValFn, /validateDungeonRunEquipment\(buddy\.run_equipment\)/, 'the buddy run_equipment validates through the SAME shared run validator');
  // A homunculus buddy carries a display_name (schema marker: present ⇒ homunculus). When present it is validated
  // non-empty; when absent (selectable) it resolves to null (the tab name then comes from the roster).
  assert.match(buddyValFn, /const hasDisplayName = Object\.prototype\.hasOwnProperty\.call\(buddy, 'display_name'\);\s*const displayName = hasDisplayName \? assertWorkshopString\(buddy\.display_name, 'buddy\.display_name'\) : null;/, 'a present buddy.display_name is validated non-empty (homunculus marker); absent = null (selectable)');
  const runValFn = js.match(/function validateDungeonRunEquipment\(runEquipment\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(runValFn, '', 'validateDungeonRunEquipment should exist');
  assert.match(runValFn, /if \(runEquipment === null \|\| runEquipment === undefined\) return null;/, 'a null run_equipment (nothing equipped) is a valid reading');
  assert.match(runValFn, /element_spell_power must be an object/, 'element_spell_power must be an object of element → positive integer (fail-fast)');

  // OPERATION: equip / unequip POST carry the explicit target (hero or the buddy's character_id) and adopt the
  // RETURNED snapshot as the sole source of truth (no optimistic slot mutation before the server confirms); an
  // in-flight guard blocks a double POST; failures reject to the equipment reporter.
  assert.match(js, /postJson\('\/api\/equipment\/equip', \{ target, slot, instance_id: instanceId \}\);\s*\n\s*renderDungeonEquipment\(snapshot\)/, 'equip posts the explicit target and re-renders from the returned authoritative snapshot (client never pre-mutates slots)');
  assert.match(js, /postJson\('\/api\/equipment\/unequip', \{ target, slot \}\);\s*\n\s*renderDungeonEquipment\(snapshot\)/, 'unequip posts the explicit target and re-renders from the returned authoritative snapshot');
  assert.match(js, /async function dungeonEquip\(target, slot, instanceId\) \{\s*\n\s*if \(dungeonEquipmentInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;/, 'a double equip is guarded by the in-flight flag');
  assert.match(js, /\} finally \{\s*\n\s*dungeonEquipmentInFlight = false;/, 'the equip/unequip only reset the in-flight guard in finally (no local error recovery)');
  assert.match(js, /dungeonEquip\(target, slot, instance\.instance_id\)\.catch\(reportDungeonEquipmentError\)/, 'a candidate click equips it onto the active target and surfaces a failure through the equipment reporter');
  assert.match(js, /dungeonUnequip\(target, slot\)\.catch\(reportDungeonEquipmentError\)/, 'the 解除 button unequips the active target slot and surfaces a failure through the equipment reporter');
  // The status reporter is the required error surface: a missing status node is broken wiring → throw.
  assert.match(js, /function setDungeonEquipmentStatus\([\s\S]*?const status = document\.querySelector\('#dungeon-equipment-status'\);\s*\n\s*if \(!status\) \{[\s\S]*?throw new Error/, 'setDungeonEquipmentStatus fails fast on missing status markup (no silent suppression of the error surface)');
  // A slot with no owned candidate of its kind shows the quiet empty state (an optional workshop nudge, no new導線).
  assert.match(js, /この種別の装備はまだありません。/, 'a slot with no owned candidate shows the quiet empty state (no new functional 導線)');

  // RUN BREAKDOWN: the aggregated correction lists non-zero scalar effects (shared effect-key order) + one row per
  // element for element_spell_power; a null run_equipment reads 補正なし (not an empty panel).
  assert.match(js, /function dungeonRunEquipmentRows\(effects\)[\s\S]*?for \(const key of WORKSHOP_EFFECT_KEYS\)[\s\S]*?element_spell_power[\s\S]*?for \(const element of WORKSHOP_ELEMENTS\)[\s\S]*?WORKSHOP_EFFECT_LABELS\[key\]/, 'the run breakdown iterates the shared effect-key order and expands element_spell_power per element with the shared label');
  assert.match(js, /const rows = runEffects \? dungeonRunEquipmentRows\(runEffects\) : \[\];[\s\S]*?補正なし/, 'a null run_equipment (未装備) reads 補正なし');

  // TARGET TABS: the entry surface renders/edits one owner at a time — the hero or the current buddy. The GET
  // snapshot carries BOTH, so a tab switch re-renders the cached snapshot (no refetch) and equip/unequip keep the
  // selected owner. No buddy → the tablist stays empty (the quiet solo state). The buddy tab label is the buddy's
  // roster display name, resolved fail-fast (never another character's name, never the raw id). A snapshot whose
  // buddy is gone/changed falls the selected owner back to the hero (a stale companion is never rendered or edited).
  assert.match(js, /function renderDungeonEquipmentTargetTabs\(view, activeTarget\)[\s\S]*?if \(!view\.buddy\) \{\s*\n\s*container\.replaceChildren\(\);\s*\n\s*return;/, 'no buddy → the target tablist stays empty (the quiet solo state)');
  assert.match(js, /buildDungeonEquipmentTargetTab\('player', '主人公', activeTarget\)/, 'the hero tab is labelled 主人公');
  assert.match(js, /buildDungeonEquipmentTargetTab\(view\.buddy\.characterId, dungeonEquipmentBuddyName\(view\.buddy\), activeTarget\)/, 'the buddy tab is labelled from the buddy sub-view (homunculus display_name or resolved roster name)');
  const buddyNameFn = js.match(/function dungeonEquipmentBuddyName\(buddy\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buddyNameFn, '', 'dungeonEquipmentBuddyName should exist');
  // A homunculus buddy uses its snapshot display_name directly; a selectable buddy (displayName null) resolves from
  // the already-loaded selectable roster, fail-fast on a missing id.
  assert.match(buddyNameFn, /if \(buddy\.displayName !== null\) return buddy\.displayName;/, 'a homunculus buddy uses its snapshot display_name directly');
  assert.match(buddyNameFn, /selectableCharacters\.find\(\(entry\) => entry\.character_id === buddy\.characterId\)/, 'a selectable buddy name comes from the already-loaded selectable roster');
  assert.match(buddyNameFn, /throw new Error\(`dungeon equipment: buddy \$\{buddy\.characterId\} does not resolve in the selectable roster`\)/, 'a selectable buddy id absent from the roster throws (no name substitution / raw-id fallback)');
  assert.match(js, /function selectDungeonEquipmentTarget\(target\)[\s\S]*?dungeonEquipmentTarget = target;[\s\S]*?renderDungeonEquipment\(dungeonLastEquipmentSnapshot\)/, 'a tab switch re-renders the cached snapshot (no refetch — both owners already live in it)');
  assert.match(js, /function activeDungeonEquipmentOwner\(view\)[\s\S]*?if \(view\.buddy && view\.buddy\.characterId === dungeonEquipmentTarget\)[\s\S]*?dungeonEquipmentTarget = 'player';/, 'a snapshot whose buddy is gone/changed falls the selected owner back to the hero');
  assert.match(js, /async function refreshDungeonEquipment\(\)[\s\S]*?dungeonEquipmentTarget = 'player';[\s\S]*?getJson\('\/api\/equipment'\)/, 'a fresh entry render resets the selected owner to the hero');

  // CSS: the equipment rules live inside the practical-dungeon token section and consume ONLY --dungeon-* / shared
  // shape tokens — no literal color pin, no borrowed shared-chrome / other-screen token (test-by-token).
  const section = css.match(/\/\* ===== Practical dungeon[\s\S]*?\n\/\* ── Routing hub screen/)?.[0] ?? '';
  assert.notEqual(section, '', 'the practical dungeon CSS section should exist');
  const equipCss = section.match(/\/\* --- entry equipment section[\s\S]*?\n\/\* --- play: HUD/)?.[0] ?? '';
  assert.notEqual(equipCss, '', 'the entry equipment CSS block should live inside the practical dungeon section');
  assert.doesNotMatch(equipCss, /#[0-9a-fA-F]{3,6}\b/, 'no literal hex color in the equipment rules (token-only)');
  assert.doesNotMatch(equipCss, /rgb\(/, 'no literal rgb() in the equipment rules (token-only)');
  assert.doesNotMatch(equipCss, /var\(--(c-|surface-|border-warm|text|eyebrow|accent-gold|routing-|cd-|alchemy-|training-|errand-|meta-)/, 'the equipment rules borrow no shared-chrome / other-screen tokens (only --dungeon-* + shape tokens)');
  const slotCss = cssRuleBlock(css, '.dungeon-equipment-slot');
  assert.match(slotCss, /background:\s*var\(--dungeon-chip\)/, 'the slot card wears the obsidian chip token');
  assert.match(slotCss, /border:\s*1px solid var\(--dungeon-line\)/, 'the slot card wears the amber hairline token');
  assert.match(slotCss, /border-radius:\s*var\(--radius-card\)/, 'the slot card consumes the shared card radius token');
  assert.match(cssRuleBlock(css, '.dungeon-equipment-run'), /background:\s*var\(--dungeon-inset\)/, 'the run-correction panel wears the obsidian inset token');
  const targetCss = cssRuleBlock(css, '.dungeon-equipment-target');
  assert.match(targetCss, /border-radius:\s*var\(--radius-pill\)/, 'the target tab is an obsidian pill (shared pill radius token)');
  assert.match(targetCss, /background:\s*var\(--dungeon-chip\)/, 'the target tab wears the obsidian chip token');
  assert.match(cssRuleBlock(css, '.dungeon-equipment-target[data-active="true"]'), /border-color:\s*var\(--dungeon-amber\)/, 'the active target tab lifts to the amber hairline token');
});
