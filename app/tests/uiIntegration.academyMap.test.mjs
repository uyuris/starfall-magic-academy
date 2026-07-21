import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('academy map uses a rich clickable map and routes selected stages into character selection', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const mapBlock = html.match(/<section id="academy-map-screen"[\s\S]*?<section id="field-screen"/)?.[0] ?? '';
  assert.match(mapBlock, /class="academy-map-shell"/, 'academy map should have a dedicated rich visual shell');
  assert.match(mapBlock, /id="academy-map-stage-layer"[\s\S]*aria-label="学院マップ上の舞台"/, 'academy map should render clickable stage points on the map layer');
  const mapDialog = html.match(/<dialog id="academy-map-location-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(mapDialog, /id="academy-map-location-image"[\s\S]*id="academy-map-go-button"[\s\S]*ここに行く[\s\S]*id="academy-map-close-button"[\s\S]*閉じる/, 'academy map dialog should show stage image, go button, and close button');
  assert.match(mapDialog, /academy-map-action-button[\s\S]*academy-map-action-button/, 'academy map dialog buttons should reuse the map hotspot visual language');
  assert.equal(mapBlock.includes('id="academy-map-location-dialog"'), true, 'the stage detail dialog now lives inside #academy-map-screen so it inherits the --am-night-* night token layer; the map stays under it (no companion screen hides the map anymore)');
  const mapHero = mapBlock.match(/<div class="academy-map-hero">[\s\S]*?<div class="academy-map-canvas"/)?.[0] ?? '';
  const mapCanvas = mapBlock.match(/<div class="academy-map-canvas"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/)?.[0] ?? '';
  const shopBlock = html.match(/<section id="shop-screen"[\s\S]*?<section id="debug-screen"/)?.[0] ?? '';
  assert.doesNotMatch(mapBlock, /各舞台にはキャラクターがランダムに配置されていますが、キャラクターの配置は表示されません。/, 'academy map should remove the old left-side random-placement helper sentence');
  assert.doesNotMatch(mapHero, /academy-map-status-card|TURN STAGE/, 'academy map should not reserve a right-side information card in the hero');
  assert.match(mapCanvas, /id="academy-map-hover-tooltip"[\s\S]*id="academy-map-hover-stage"[\s\S]*id="academy-map-hover-description"/, 'hovered-stage description should live as a tooltip on the map canvas near the hovered point');
  assert.match(shopBlock, /id="shop-title">購買<\/[\s\S]*id="shop-back-to-map"[^>]*>学院マップに戻る</, 'shop screen should include a dedicated return-to-academy-map button');

  // Conversation-partner selection is a night-styled popup on the map (no separate companion screen). The
  // popup lives inside #academy-map-screen so it inherits the --am-night-* night layer.
  assert.doesNotMatch(html, /id="academy-companion-screen"/, 'the standalone conversation-partner screen must be gone (selection is a map popup now)');
  assert.match(mapBlock, /id="academy-map-companion-popup"[\s\S]*id="academy-map-companion-popup-title"[\s\S]*id="academy-map-companion-popup-stage"[\s\S]*id="academy-map-companion-popup-body"/, 'the map should carry a conversation-partner popup (title + confirmed stage + candidate body) inside the map screen');
  assert.match(mapBlock, /id="academy-map-companion-popup"[^>]*hidden/, 'the conversation-partner popup should start hidden and only open after a confirmed move');
  assert.match(mapBlock, /id="academy-map-companion-popup"[\s\S]*data-am-companion-close="true"/, 'the popup should keep backdrop + close dismissal (closing stays on the map)');
  // Header band night restyle: the English eyebrow is dropped; the heading + short lead read in the night silver layer.
  assert.doesNotMatch(mapHero, /class="eyebrow"|Academy Map/, 'the map header band should drop the old English eyebrow');
  assert.match(mapHero, /class="academy-map-heading"[\s\S]*id="academy-map-title"[\s\S]*id="academy-map-lead"/, 'the header band keeps a night heading (title + short lead) without the eyebrow');
  assert.match(css, /#academy-map-screen \.academy-map-heading h2\s*\{[\s\S]*color:\s*var\(--am-night-silver-strong\)/, 'the night heading title is painted from the map night silver token, not the dark-shell text tokens');
  assert.match(css, /#academy-map-screen #academy-map-lead\s*\{[\s\S]*color:\s*var\(--am-night-silver\)[\s\S]*opacity:\s*0\.62/, 'the header lead consumes the existing --am-night-silver token and mutes via element opacity (no new token / literal color pin)');
  assert.doesNotMatch(css, /--am-cream|--am-sun|--am-ink/, 'no day-layer token (cream/sun/ink) should survive the night restyle; the header consumes the --am-night-* layer only');

  assert.match(js, /const academyMapStagePinCoordinates = \{[\s\S]*学院マップのピン座標はここを編集します[\s\S]*courtyard_fountain: \{ x: 50\.4, y: 42\.3 \}[\s\S]*alchemy_lab: \{ x: 16\.5, y: 83\.3 \}[\s\S]*underground_waterway: \{ x: 18\.4, y: 96\.2 \}[\s\S]*academy_shop: \{ x: 31, y: 29\.6 \}[\s\S]*main_hall_runaway_golem: \{ x: 5\.6, y: 92\.2 \}/, 'academy map stage pins should match the provided day-map art percentage coordinates (33 stages) plus the fixed shop pin');
  // The temporary browser-local pin drag editor (and its dead enable flag) is gone: pin recalibration now runs
  // through the shared dev calibration tool (?calibrate=academy-map), which exports a JS object to paste back
  // into the truth source rather than persisting a parallel browser store.
  assert.doesNotMatch(js, /ACADEMY_MAP_PIN_DRAG_EDITING_ENABLED/, 'the dead temporary pin-drag enable flag must be removed (pin calibration is the ?calibrate=academy-map tool now)');
  assert.match(js, /const MAP_PIN_CALIBRATION_COORDINATE_SOURCES = \{ academyMapStagePinCoordinates, sanrinMapStagePinCoordinates \}/, 'the calibration tool maps each pin registry coordinatesName (academy + sanrin) to its real truth-source object');
  assert.match(js, /const ACADEMY_MAP_EVENT_LOCATION_IDS = new Set\(\[[\s\S]*'sealed_ritual_room'[\s\S]*'festival_plaza_night'[\s\S]*'mirror_hall'[\s\S]*'snowy_inner_garden'[\s\S]*'rainy_cloister'[\s\S]*\]\)/, 'event maps should be declared in one set so pins and random character placement can exclude the same stages');
  assert.doesNotMatch(js, /magic-academy:academy-map-pin-coordinates|academyMapStoredPinCoordinates|rememberAcademyMapPinCoordinate|exportAcademyMapPinCoordinates/, 'fixed academy-map coordinates should not keep the temporary pin-calibration storage/export path after integration');
  assert.match(js, /const ACADEMY_MAP_SHOP_NODE_ID = 'academy_shop'/, 'academy map should declare a stable special-node id for shop access');
  assert.match(js, /function academyMapShopNode\(\)[\s\S]*id: ACADEMY_MAP_SHOP_NODE_ID[\s\S]*display_name: '購買'[\s\S]*description: '各種霊薬を取り揃えている学院購買部。必要な道具や品物を売買できる。'[\s\S]*visible_situation: '各種霊薬を取り揃えている学院購買部。必要な道具や品物を売買できる。'/, 'shop access should be modeled as a dedicated academy-map special node instead of a normal field location');
  assert.match(js, /function isAcademyMapShopNode\(nodeOrId\)[\s\S]*nodeId === ACADEMY_MAP_SHOP_NODE_ID/, 'academy map should detect the special shop node explicitly');
  assert.match(js, /function academyMapRenderableNodes\(locations = academyMapLocations\(\)\)[\s\S]*return \[\.\.\.academyMapConversationLocations\(locations\), academyMapShopNode\(\)\];/, 'academy map rendering should append the shop node without polluting normal conversation locations');
  assert.match(js, /function renderAcademyMapLocationPreview\(location\)[\s\S]*const goButton = document\.querySelector\('#academy-map-go-button'\);[\s\S]*goButton\.textContent = isAcademyMapShopNode\(location\)[\s\S]*\? '購買に行く'[\s\S]*: isSanrinMapGatheringNode\(location\)[\s\S]*\? '採取に行く'[\s\S]*: 'ここに行く'/, 'shared map dialog should switch the primary action label by node type (購買 / 採取 / normal stage)');
  assert.match(js, /function academyMapPointFor\(locationIdOrIndex, indexOrTotal, maybeTotal\)[\s\S]*academyMapStagePinCoordinates\[locationId\][\s\S]*if \(configuredPoint\) return configuredPoint[\s\S]*const columns = 5/, 'academy map point placement should use configured coordinates first and keep a uniform fallback grid');
  assert.match(js, /function isAcademyEventMapLocation\(locationOrId\)[\s\S]*ACADEMY_MAP_EVENT_LOCATION_IDS\.has\(locationId\)/, 'event-map identity should be reusable instead of duplicated by display and placement code');
  assert.match(js, /function academyMapConversationLocations\(locations = academyMapLocations\(\)\)[\s\S]*locations\.filter\(\(location\) => !isAcademyEventMapLocation\(location\)\)/, 'normal academy-map locations should exclude event maps');
  assert.match(js, /const mapLocations = academyMapRegionRenderableNodes\(region, field\?\.locations \?\? \[\]\)[\s\S]*mapLocations\.map\(\(candidate, index\) => \{[\s\S]*const point = academyMapPointFor\(candidate\.id, index, mapLocations\.length\)/, 'academy map rendering should render the active region nodes while still positioning all nodes by id');
  assert.match(js, /function academyMapRegionLocations\(region = activeMapRegion, locations = academyMapLocations\(\)\)[\s\S]*locations\.filter\(\(location\) => mapLocationRegion\(location\) === region\)/, 'region nodes should be filtered by the backend-provided location region field');
  assert.match(js, /function academyMapRegionRenderableNodes\(region = activeMapRegion, locations = academyMapLocations\(\)\)[\s\S]*region === 'academy'[\s\S]*academyMapRenderableNodes\(regionLocations\)[\s\S]*academyMapConversationLocations\(regionLocations\)/, 'the academy 購買 special node should appear only in the academy region; other regions show only their own conversation stages');
  assert.doesNotMatch(js, /enableAcademyMapPinDragEditing\(button, candidate\)/, 'fixed academy-map rendering should not wire the temporary browser-local drag editor');
  assert.doesNotMatch(js, /academyMapPointFor[\s\S]*row % 2 \? 5 : 0[\s\S]*Math\.min\(91, x\)/, 'academy map point placement should not stagger rows into a right-edge clamp that makes the map feel crowded on the right');
  assert.match(js, /academyMapSelectedLocationId/, 'browser should remember the selected academy-map stage');
  assert.match(js, /academyMapCharacterAssignments/, 'browser should store internal random character placement for academy map stages');
  assert.match(js, /function rerollAcademyMapCharacterAssignments\(\)[\s\S]*academyMapAssignmentSignature = academyMapCurrentAssignmentSignature\(\)[\s\S]*const locationBuckets = Object\.fromEntries\(locations\.map\(\(location\) => \[location\.id, \[\]\]\)\)[\s\S]*const shuffledLocations = academyMapConversationLocations\(locations\)[\s\S]*\.filter\(\(location\) => mapLocationRegion\(location\) === 'academy'\)[\s\S]*\.sort\(\(\) => Math\.random\(\) - 0\.5\)[\s\S]*const location = shuffledLocations\[index % shuffledLocations\.length\][\s\S]*if \(location\) locationBuckets\[location\.id\]\.push\(character\.character_id\)/, 'academy character placement should be scoped to academy-region non-event stages so academy characters never scatter onto other regions, and record the state signature that produced it');
  assert.match(js, /function ensureAcademyMapCharacterAssignments\(\{ force = false \} = \{\}\)[\s\S]*force \|\| !Object\.keys\(academyMapCharacterAssignments\)\.length[\s\S]*rerollAcademyMapCharacterAssignments\(\)[\s\S]*renderAcademyMap\(currentField\)/, 'academy map should preserve placement across access routes and reroll only when explicitly forced or when placement is missing');
  assert.match(js, /function academyMapLocations\(\)[\s\S]*return currentField\?\.locations \?\? \[\]/, 'academy map stages come from the server-evaluated field, which is where the backend stamps the persisted current_location_visible_situation onto the current stage');
  assert.match(js, /function selectedAcademyStageSituation\(locationOrId\)[\s\S]*return location\.visible_situation \?\? ''/, 'stage description is read live from the server-evaluated field visible_situation (the current stage carries the persisted current_location_visible_situation) — no client-side precedence and no client-side default fallback on the truth path (any inserted fallback chain breaks this contiguous return)');
  assert.doesNotMatch(js, /academyMapStageSituationAssignments/, 'the client-side per-stage situation store that shadowed the persisted truth and froze at session-start values must be gone (stage situation is derived from the server-evaluated field, not stored and rerolled with character placement)');
  assert.doesNotMatch(js, /randomStageSituation/, 'the map must not client-side randomize a stage situation; situations follow the server-selected truth, not a meaningless re-roll on render');
  assert.match(js, /#dungeon-back-to-map[\s\S]*showScreen\('academy-map'\)/, 'returning from the dungeon re-shows the academy map (renderAcademyMap re-reads the live field), so the stage description reflects the current truth on return just like the companion/shop/gathering returns');
  assert.match(js, /showScreen\(name, \{ rerollAcademyMap = false, skipDungeonRefresh = false \} = \{\}\)[\s\S]*name === 'academy-map'[\s\S]*ensureAcademyMapCharacterAssignments\(\{ force: rerollAcademyMap \}\)/, 'showing the academy map normally should not reroll buddy placement just because the player reached it through a different route');
  assert.match(js, /function assignedAcademyMapCharactersFor\(locationId\)/, 'companion selection should read only characters assigned to the selected stage');
  assert.match(js, /let academyCompanionLocationId = null/, 'browser should keep the confirmed companion stage separately from the transient map dialog selection');
  assert.match(js, /function renderAcademyMapCompanionPopup\(locationId = academyCompanionLocationId\)[\s\S]*document\.querySelector\('#academy-map-companion-popup-stage'\)[\s\S]*const candidates = stageOccupantsFor\(location\)/, 'the popup renderer names the confirmed stage and reads its candidates from the shared stage-occupants helper');
  assert.match(js, /button\.addEventListener\('click', \(\) => startAcademyMapCompanionConversation\(character\.character_id\)\)/, 'a popup candidate card starts the conversation directly with the chosen character (no intermediate detail dialog)');
  assert.match(js, /function startAcademyMapCompanionConversation\(characterId\)[\s\S]*closeAcademyMapCompanionPopup\(\);\s*\n\s*startConversationDay\(characterId\)\.catch\(reportError\);/, 'selecting a candidate closes the popup and lands the conversation on the daytime screen (routing is official — no legacy landing choice)');
  assert.match(js, /function startAcademyMapCompanionConversation\(characterId\)\s*\{[\s\S]*if \(!characterId\)\s*\{[\s\S]*throw new Error\(`academy map companion conversation requires a character id/, 'the popup start entrypoint fails fast on a missing character id (no silent no-op) — absolute rules');
  assert.match(js, /function updateAcademyMapHoverPreview\(location, point = null\)[\s\S]*#academy-map-hover-tooltip[\s\S]*renderAcademyMapHoverOccupants\(location\)[\s\S]*positionAcademyMapHoverTooltip\(tooltip, point\)/, 'hover preview should fill content first, then position the tooltip via the measured placement helper');
  assert.match(js, /import \{ computeMapHoverTooltipPlacement \} from '\.\/mapHoverPlacement\.js'/, 'app.js should import the pure tooltip-placement geometry so the same logic is unit-testable headlessly');
  assert.match(js, /function positionAcademyMapHoverTooltip\(tooltip, point\)[\s\S]*const canvas = tooltip\.offsetParent[\s\S]*computeMapHoverTooltipPlacement\(\{[\s\S]*canvasWidth: canvas\.clientWidth[\s\S]*canvasHeight: canvas\.clientHeight[\s\S]*tooltipWidth: tooltip\.offsetWidth[\s\S]*tooltipHeight: tooltip\.offsetHeight[\s\S]*pointXPercent: point\.x[\s\S]*pointYPercent: point\.y[\s\S]*gap: MAP_HOVER_TOOLTIP_GAP_PX[\s\S]*\}\)[\s\S]*tooltip\.style\.left = `\$\{left\}px`[\s\S]*tooltip\.style\.top = `\$\{top\}px`/, 'placement should be derived from the live popup size and the canvas size via the pure helper, then written as px (no hard-coded percentage thresholds)');
  assert.doesNotMatch(js, /tooltip\.classList\.toggle\('is-(left|below)'/, 'the old hard-coded percent-threshold flip classes must be gone (placement is size-synced now)');
  assert.match(js, /function renderAcademyMap\(field\)/, 'browser should render map hotspots from field locations');
  assert.match(js, /function stageHasAssignedBuddy\(locationId\)[\s\S]*const buddyCharacterId = selectedAcademyBuddyCharacterId\(\)[\s\S]*return Boolean\(buddyCharacterId\) && assignedAcademyMapCharactersFor\(locationId\)\.some\(\(character\) => character\.character_id === buddyCharacterId\)/, 'academy map should define buddy presence from the current runtime buddy, not from every assigned character');
  assert.match(js, /function selectedAcademyBuddyCharacterId\(\)[\s\S]*currentRuntimeState\?\.current_buddy_character_id[\s\S]*selectableCharacters\.find\(\(character\) => character\.is_buddy === true\)/, 'academy map should read buddy presence from the authoritative current buddy state exposed by the backend');
  assert.match(js, /function selectedAcademyEnemyCharacterIds\(\)[\s\S]*currentRuntimeState\?\.current_enemy_character_ids[\s\S]*selectableCharacters\.filter\(\(character\) => character\.is_enemy === true\)/, 'academy map should read enemy presence from the authoritative current enemy list exposed by the backend');
  assert.match(js, /function stageHasAssignedEnemy\(locationId\)[\s\S]*const enemyCharacterIds = selectedAcademyEnemyCharacterIds\(\)[\s\S]*return assignedAcademyMapCharactersFor\(locationId\)\.some\(\(character\) => enemyCharacterIds\.has\(character\.character_id\)\)/, 'academy map should mark stages containing any current enemy');
  assert.doesNotMatch(js.match(/function selectedAcademyBuddyCharacterId\(\)[\s\S]*?\n\}/)?.[0] ?? '', /current_interaction_character_id/, 'active interaction character must not be treated as the buddy because it makes map pins and status depend on access path');
  assert.doesNotMatch(js.match(/function selectedAcademyEnemyCharacterIds\(\)[\s\S]*?\n\}/)?.[0] ?? '', /current_interaction_character_id/, 'active interaction character must not be treated as an enemy because it makes map pins and status depend on access path');
  assert.match(js, /const hasBuddy = stageHasAssignedBuddy\(candidate\.id\)[\s\S]*const hasEnemy = stageHasAssignedEnemy\(candidate\.id\)/, 'academy map should derive buddy/enemy presence from the actual assignment helpers, not from every stage with any assigned character');
  assert.match(js, /button\.classList\.toggle\('has-buddy', hasBuddy\)[\s\S]*button\.classList\.toggle\('has-enemy', hasEnemy\)/, 'academy map should keep marking buddy/enemy state on the node so the asset image reflects it');
  assert.match(js, /openAcademyMapLocationDialog\(candidate\)/, 'clicking a map node should open the stage detail dialog instead of moving immediately');
  assert.match(js, /async function goToAcademyMapLocation\(\)[\s\S]*if \(isAcademyMapShopNode\(academyMapSelectedLocationId\)\) \{[\s\S]*document\.querySelector\('#academy-map-location-dialog'\)\.close\(\);[\s\S]*showScreen\('shop'\);[\s\S]*return;[\s\S]*\}/, 'shop node action should close the shared dialog and open the shop screen instead of moving to a conversation stage');
  assert.match(js, /academyCompanionLocationId = academyMapSelectedLocationId[\s\S]*moveToLocation\(academyCompanionLocationId, \{[\s\S]*nextScreen: 'academy-map',[\s\S]*selectedVisibleSituation: selectedAcademyStageSituation\(academyCompanionLocationId\)[\s\S]*\}\)/, 'go button should confirm normal stages, send the selected stage description, and land back on the map screen');
  assert.match(js, /openAcademyMapCompanionPopup\(academyCompanionLocationId\)/, 'a confirmed academy-map move opens the conversation-partner popup over the map');
  assert.doesNotMatch(js, /showScreen\('academy-companion'\)/, 'there is no separate companion screen to switch to anymore');
  assert.match(js, /#academy-map-go-button/, 'browser should wire the academy map go button');
  assert.match(js, /#academy-map-close-button/, 'browser should wire the academy map close button');
  assert.match(js, /#shop-back-to-map[\s\S]*showScreen\('academy-map', \{ rerollAcademyMap: false \}\)/, 'shop screen should return to academy map without rerolling hidden assignments');

  assert.match(css, /:root\s*\{[\s\S]*--runtime-reading-font:\s*ui-serif, "Hiragino Mincho ProN", "Yu Mincho", serif/, 'runtime should centralize the conversation reading font for academy map, companion, and session screens');
  assert.match(css, /(?:^|\n)button,\n?input,\n?textarea,\n?select\s*\{[\s\S]*font-family:\s*var\(--runtime-reading-font\)/, 'buttons and form controls should inherit the same reading font as conversation bubbles instead of falling back to browser sans-serif');
  assert.match(css, /\.screen-tabs button\s*\{[\s\S]*font-family:\s*var\(--runtime-reading-font\)/, 'the moonlit debug tab buttons carry their own rule but keep the same reading font as the other controls');
  assert.match(css, /\.academy-map-hero h2\s*\{[\s\S]*font-size:\s*clamp\(18px, 1\.8vw, 22px\)[\s\S]*line-height:\s*1\.35[\s\S]*letter-spacing:\s*0/, 'academy map and conversation-partner hero titles should be only slightly larger than their description text');
  assert.match(css, /\.layout:has\(#academy-map-screen\.active\)\s*\{[\s\S]*height:\s*calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*padding:\s*0[\s\S]*overflow:\s*hidden/, 'academy map layout should lock to the viewport with no padding so the deep-night ground bleeds edge-to-edge (no blue-background margin around a windowed card)');
  assert.match(css, /#academy-map-screen\.active[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/, 'academy map screen should fit inside the viewport-bound layout');
  assert.match(css, /:root\b[\s\S]*--surface-map-shell:[\s\S]*linear-gradient\(135deg, rgb\(9 13 22 \/ 0\.96\)[\s\S]*radial-gradient\(circle at 72% 18%, rgb\(121 183 255 \/ 0\.22\)/, 'theme should define the academy map shell surface token with the previous dark premium values');
  assert.match(css, /:root\b[\s\S]*--border-shell-glass:\s*rgb\(255 255 255 \/ 0\.08\)[\s\S]*--shadow-map-shell:\s*0 32px 86px rgb\(0 0 0 \/ 0\.52\), inset 0 1px 0 rgb\(255 255 255 \/ 0\.06\)/, 'theme should define the academy map shell border and shadow tokens with the previous glass values');
  const academyMapShellCss = cssRuleBlock(css, '.academy-map-shell');
  assert.match(academyMapShellCss, /display:\s*grid[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*height:\s*100%/, 'academy map shell should keep sizing the canvas to remaining height');
  const nonTrainingMapShellCss = cssRuleBlock(css, '.academy-map-shell:not(.academy-training-shell)');
  assertBigframeShell(nonTrainingMapShellCss, 'non-training academy map shell');
  assertNoCoolOrSoftBorderToken(nonTrainingMapShellCss, 'non-training academy map shell');
  assert.match(css, /\.academy-map-canvas\s*\{[\s\S]*width:\s*min\(100%, calc\(\(100dvh - var\(--runtime-topbar-height, 88px\) - 164px\) \* 1672 \/ 941\)\)[\s\S]*aspect-ratio:\s*1672 \/ 941[\s\S]*var\(--surface-map-canvas-overlay\),[\s\S]*url\('\/canonical\/academy_map\/overview\.jpg'\)[\s\S]*var\(--surface-map-canvas-base\)[\s\S]*background-repeat:\s*no-repeat[\s\S]*background-size:\s*cover, 100% 100%, cover[\s\S]*box-shadow:\s*var\(--shadow-map-canvas\)/, 'academy map canvas should reserve enough vertical room for the shell/header while matching the day overview image ratio and tokenized pin coordinate area');
  const academyMapNodeCss = cssRuleBlock(css, '.academy-map-node');
  assert.match(academyMapNodeCss, /position:\s*absolute/, 'map nodes stay absolutely positioned on the overview map');
  assert.match(academyMapNodeCss, /background-repeat:\s*no-repeat[\s\S]*background-position:\s*center bottom[\s\S]*background-size:\s*contain/, 'map nodes render the region+state pin asset contained and anchored bottom-center');
  assert.match(academyMapNodeCss, /transform:\s*translate\(-50%, -100%\) rotate\(0deg\)[\s\S]*transform-origin:\s*50% 100%/, 'pins keep the bottom-center coordinate anchor so the tip points at the stage location');
  assert.doesNotMatch(academyMapNodeCss, /clip-path|--academy-map-pin-fill|var\(--shadow-map-pin\)/, 'image pins drop the old crystal clip-path/gradient/shadow chrome');
  assert.doesNotMatch(css, /\.academy-map-node::before|\.academy-map-node::after/, 'image pins drop the old crystal facet/glint pseudo-elements');
  assert.doesNotMatch(css, /\.academy-map-node span/, 'the old per-pin stage-name label pill must be gone so only the unified hover tooltip shows the stage name');
  assert.doesNotMatch(js, /const label = document\.createElement\('span'\)[\s\S]*button\.replaceChildren\(label\)/, 'map pin buttons must not render an inner stage-name label span (the redesigned tooltip is the single stage-name surface)');
  assert.doesNotMatch(css, /--surface-map-pin-label|--shadow-map-pin-label/, 'the removed pin-label pill must not leave dead design tokens behind');
  const hoverOccupantsCss = cssRuleBlock(css, '.academy-map-hover-occupants');
  assert.match(hoverOccupantsCss, /flex-direction:\s*column/, 'hover popup occupants should stack vertically so each name owns its own line');
  const hoverOccupantNamesCss = cssRuleBlock(css, '.academy-map-hover-occupants-names');
  assert.match(hoverOccupantNamesCss, /flex-direction:\s*column/, 'occupant name list should be a single vertical column (one character per line)');
  const hoverOccupantChipCss = cssRuleBlock(css, '.academy-map-hover-occupant-chip');
  assert.match(hoverOccupantChipCss, /white-space:\s*nowrap[\s\S]*text-overflow:\s*ellipsis/, 'each occupant name must stay on one line without mid-name wrapping, truncating with an ellipsis if it overflows');
  assert.match(js, /mapPinImageUrls\s*=\s*\{[\s\S]*academy_neutral:\s*'\/canonical\/map_pins\/academy_neutral\.png'[\s\S]*academy_buddy:\s*'\/canonical\/map_pins\/academy_buddy\.png'[\s\S]*academy_enemy:\s*'\/canonical\/map_pins\/academy_enemy\.png'[\s\S]*sanrin_neutral:\s*'\/canonical\/map_pins\/sanrin_neutral\.png'\s*\}/, 'the four region+state map pins should be wired by their canonical /canonical/map_pins asset urls');
  assert.match(css, /\.academy-map-node:hover:not\(:disabled\),\n\.academy-map-node:focus-visible:not\(:disabled\)\s*\{[\s\S]*transform:\s*translate\(-50%, -100%\) rotate\(0deg\);[\s\S]*filter:\s*brightness\(1\.16\)/, 'hover/focus should not move or scale the crystal pin hit target, preventing hover-selection jitter');
  const pinHoverBlock = css.match(/\.academy-map-node:hover:not\(:disabled\),\n\.academy-map-node:focus-visible:not\(:disabled\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(pinHoverBlock, /filter:\s*brightness\(1\.16\)/, 'map pin hover should brighten the asset in place instead of changing a crystal border');
  assert.doesNotMatch(pinHoverBlock, /translateY\(-4px\)|scale\(1\.08\)/, 'map pin hover must not shrink/shift itself out from under the cursor');
  const academyMapPinImageFn = js.match(/function academyMapPinImageUrl\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(academyMapPinImageFn, /region === 'sanrin'[\s\S]*sanrin_neutral/, 'sanrin map pins use the ③ neutral medallion asset (sanrin map pins have no buddy/enemy state)');
  assert.match(academyMapPinImageFn, /region === 'academy'[\s\S]*if \(hasBuddy\) return mapPinImageUrls\.academy_buddy[\s\S]*if \(hasEnemy\) return mapPinImageUrls\.academy_enemy[\s\S]*return mapPinImageUrls\.academy_neutral/, 'academy pins map buddy→buddy asset and enemy→enemy asset, buddy winning over enemy on overlap, otherwise neutral');
  assert.match(academyMapPinImageFn, /throw new Error\(`unknown map region/, 'an unknown map region should fail fast rather than silently fall back to a default pin');
  assert.match(js, /button\.style\.backgroundImage = [^\n]*academyMapPinImageUrl\(region, hasBuddy, hasEnemy\)/, 'renderAcademyMap should paint each pin from the region+state asset resolver');
  assert.doesNotMatch(css, /\.academy-map-node\.current/, 'academy map blue focus should be decoupled from the field current location');
  const hoverTooltipCss = cssRuleBlock(css, '.academy-map-hover-tooltip');
  assert.match(hoverTooltipCss, /position:\s*absolute[\s\S]*transform:\s*scale\(0\.96\)[\s\S]*pointer-events:\s*none/, 'hover preview should be an absolute, JS-positioned tooltip whose CSS only carries the scale entrance (no hard-coded translate placement)');
  assert.doesNotMatch(hoverTooltipCss, /transform:\s*translate/, 'the hover tooltip base rule must not carry a hard-coded translate placement (position is measured in JS)');
  assert.doesNotMatch(css, /\.academy-map-hover-tooltip\.is-(left|below)/, 'the old percent-threshold flip variants must be removed from CSS');
  assert.match(css, /\.academy-map-hover-tooltip\.is-visible[\s\S]*opacity:\s*1[\s\S]*scale\(1\)/, 'hover preview tooltip should become visible on pin hover or focus');
  const academyActionButtonCss = cssRuleBlock(css, '.academy-map-action-button');
  assert.match(academyActionButtonCss, /border:\s*var\(--border-academy-action-button\)[\s\S]*background:\s*var\(--btn-secondary-bg\)[\s\S]*color:\s*var\(--text-strong\)[\s\S]*box-shadow:\s*var\(--shadow-map-button\)/, 'dialog actions should visually match the single shared warm-gold action button chrome');
  assertNoCoolOrSoftBorderToken(academyActionButtonCss, 'shared academy action button');
  const academyActionPrimaryCss = cssRuleBlock(css, '.academy-map-action-button.primary');
  const academyActionSecondaryCss = cssRuleBlock(css, '.academy-map-action-button.secondary');
  assert.doesNotMatch(`${academyActionPrimaryCss}\n${academyActionSecondaryCss}`, /border-color|background|color/, 'primary and secondary academy action buttons should not override the shared button border/fill/text color');
  // The stage dialog's OWN action buttons (ここに行く=主 / 閉じる=従) are repainted into the deep-night silver
  // layer, scoped to #academy-map-location-dialog so the shared warm-gold chrome asserted just above still applies
  // on every other screen. Every state consumes --am-night-* only (test-by-token: no literal color pin, no
  // day/shared button token), and the primary/secondary 主従 distinction survives.
  const dialogActionBaseCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button');
  assert.match(dialogActionBaseCss, /border:\s*1px solid var\(--am-night-line-strong\)[\s\S]*background:\s*var\(--am-night-panel\)[\s\S]*color:\s*var\(--am-night-silver-strong\)[\s\S]*box-shadow:\s*0 0 10px var\(--am-night-glow\)/, 'the stage dialog buttons are repainted as deep-night silver panels with the starlight hairline (map night tokens, not the shared warm-gold chrome)');
  const dialogActionPrimaryCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button.primary');
  assert.match(dialogActionPrimaryCss, /border-color:\s*var\(--am-night-starlight\)[\s\S]*background:\s*var\(--am-night-2\)[\s\S]*color:\s*var\(--am-night-moon\)/, 'the primary 「ここに行く」 stays visually dominant via the starlight edge, brighter night fill, and moon-white label');
  const dialogActionSecondaryCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button.secondary');
  assert.match(dialogActionSecondaryCss, /border-color:\s*var\(--am-night-line\)[\s\S]*color:\s*var\(--am-night-silver\)/, 'the secondary 「閉じる」 reads as subordinate via the quieter hairline and dimmer silver label');
  const dialogActionHoverCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button:hover:not(:disabled)');
  assert.match(dialogActionHoverCss, /border-color:\s*var\(--am-night-starlight\)[\s\S]*background:\s*var\(--am-night-panel-strong\)[\s\S]*box-shadow:\s*0 0 18px var\(--am-night-glow\)/, 'hover brightens the night panel with the starlight edge (no warm-gold hover border / --shadow-map-button-hover)');
  const dialogActionFocusCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button:focus-visible');
  assert.match(dialogActionFocusCss, /border-color:\s*var\(--am-night-starlight\)[\s\S]*box-shadow:\s*0 0 0 2px var\(--am-night-glow\)/, 'focus-visible shows the starlight ring built from the night glow token');
  const dialogActionActiveCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button:active:not(:disabled)');
  assert.match(dialogActionActiveCss, /border-color:\s*var\(--am-night-starlight\)[\s\S]*background:\s*var\(--am-night-2\)/, 'active keeps the pressed state inside the night token layer');
  const dialogActionDisabledCss = cssRuleBlock(css, '#academy-map-location-dialog .academy-map-action-button:disabled');
  assert.match(dialogActionDisabledCss, /background:\s*var\(--am-night-panel\)[\s\S]*color:\s*var\(--am-night-silver-dim\)/, 'a disabled dialog button dims into the night panel with the muted silver token');
  const dialogActionAllCss = [dialogActionBaseCss, dialogActionPrimaryCss, dialogActionSecondaryCss, dialogActionHoverCss, dialogActionFocusCss, dialogActionActiveCss, dialogActionDisabledCss].join('\n');
  assert.doesNotMatch(dialogActionAllCss, /--c-gold|--c-cream|--btn-secondary-bg|--btn-primary-bg|--text-strong|--border-academy-action-button|--shadow-map-button/, 'the dialog buttons must not consume any day/shared warm-gold button token (test-by-token night contract)');
  assert.doesNotMatch(dialogActionAllCss, /#[0-9a-fA-F]{3,8}\b/, 'the dialog button night states must not pin a literal hex color (--am-night-* tokens only)');
  assert.match(css, /\.academy-companion-character-detail-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(360px, 420px\) minmax\(340px, 1fr\)[\s\S]*gap:\s*32px/, 'academy companion detail image and parameter columns should have explicit separation so frames do not overlap');
  assert.match(css, /\.academy-companion-standee-frame\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%[\s\S]*min-height:\s*420px/, 'academy companion standee should stay inside its grid column instead of overlapping parameters');
  // The conversation-partner popup is painted from the map night token layer (test-by-token), not the shared
  // dark-shell tokens — the deep-night deck the face icons sit placed on (not floating on white).
  const companionPopupCardCss = cssRuleBlock(css, '.academy-map-companion-popup-card');
  assert.match(companionPopupCardCss, /border:\s*1px solid var\(--am-night-line-strong\)[\s\S]*background:\s*var\(--am-night-panel-strong\)/, 'the companion popup card is a deep-night silver panel with the starlight hairline');
  assert.match(css, /\.academy-map-companion-popup\s*\{[\s\S]*position:\s*absolute[\s\S]*z-index:\s*8/, 'the popup overlays the map above the category rail so its backdrop cannot be clicked through');
  assert.match(css, /\.academy-map-companion-popup\[hidden\]\s*\{[\s\S]*display:\s*none/, 'the popup keeps the [hidden] display guard');
  const companionCardCss = cssRuleBlock(css, '.academy-map-companion-card');
  assert.match(companionCardCss, /border:\s*1px solid var\(--am-night-line\)[\s\S]*background:\s*var\(--am-night-panel\)[\s\S]*color:\s*var\(--am-night-silver\)/, 'candidate cards consume the map night tokens (no dark-shell or literal color pin)');
  assertNoCoolOrSoftBorderToken(companionCardCss, 'companion popup card');
  assert.match(css, /\.academy-map-companion-card\.is-buddy::after\s*\{\s*content:\s*'バディー'/, 'the popup labels the current buddy');
  assert.match(css, /\.academy-map-companion-card\.is-enemy::after\s*\{\s*content:\s*'エネミー'/, 'the popup labels current enemies');
  assert.match(js, /button\.className = 'academy-map-companion-card'/, 'popup candidate cards use the map-scoped card class');
  assert.match(js, /button\.classList\.toggle\('is-buddy', character\.is_buddy === true\)[\s\S]*button\.classList\.toggle\('is-enemy', character\.is_enemy === true\)/, 'popup candidate cards tag buddy and enemy characters from backend flags');
  assert.match(css, /\.academy-map-companion-card img\s*\{[\s\S]*border:\s*1px solid var\(--am-night-line-strong\)/, 'candidate face icons use the night starlight hairline token so they read as placed on the deck, not floating');
});

test('academy map wears the "night academy" layer: full-bleed deep-night ground (no windowed shell), left category rail → night drawer, week glyph, and an arrival settle-in (index.html + style.css + app.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const mapBlock = html.match(/<section id="academy-map-screen"[\s\S]*?<section id="field-screen"/)?.[0] ?? '';

  // Map image switched to the day overview; the old dark overview file/reference is gone (no fallback).
  assert.match(css, /url\('\/canonical\/academy_map\/overview\.jpg'\)/, 'academy map canvas should reference the new day overview image');
  assert.doesNotMatch(css, /academy_overview_map/, 'the old dark overview map reference must be gone (no .png/.jpg or old/new path fallback)');
  assert.doesNotMatch(js, /academy_overview_map/, 'no app.js reference to the deleted overview map should remain');

  // All 33 academy-region stage seeds from the art task are reflected into the single truth source
  // (academyMapStagePinCoordinates), not just the sampled ids — one source of truth, no parallel store.
  const pinBlock = js.match(/const academyMapStagePinCoordinates = \{[\s\S]*?\n\};/)?.[0] ?? '';
  const academyStageSeed = {
    front_gate_morning: [50, 82], courtyard_fountain: [50.4, 42.3], old_corridor: [41, 51.6],
    library_reading_room: [26, 80], forbidden_archive_door: [65.6, 27], herbology_garden: [19, 45],
    infirmary_soft_light: [20.6, 30.4], alchemy_lab: [16.5, 83.3], astronomy_tower_observatory: [72.2, 16.2],
    rooftop_wind_bells: [84, 18.3], dormitory_lounge: [82.2, 32.5], student_cafeteria_magic_lamps: [65.9, 67.3],
    training_ground_runes: [11.7, 23.9], dueling_arena_empty: [19.4, 13.3], chapel_of_stars: [7.3, 42.4],
    music_room_enchanted_piano: [75.3, 50.7], art_room_golem_models: [77.2, 80.2], magic_tool_workshop: [86.9, 63.1],
    map_room_suspended_globe: [38.2, 90.2], clocktower_staircase: [34.2, 20.4], underground_waterway: [18.4, 96.2],
    crystal_cave_below_school: [92.9, 86.2], snowy_inner_garden: [23.3, 97.3], rainy_cloister: [2.5, 87.8],
    festival_plaza_night: [26.5, 97.4], student_council_room: [54.1, 19.1], teacher_office_evening: [47, 19.1],
    familiar_stables: [11.7, 68.4], mirror_hall: [2.3, 63.3], sealed_ritual_room: [3.6, 80.2],
    unsealed_necromancer_ritual_room: [8.6, 95.6], age_of_gods_elixir_brewing_stage: [2.3, 71.7],
    main_hall_runaway_golem: [5.6, 92.2]
  };
  assert.equal(Object.keys(academyStageSeed).length, 33, 'the brief seed covers all 33 academy-region stages');
  for (const [id, [x, y]] of Object.entries(academyStageSeed)) {
    assert.match(pinBlock, new RegExp(`\\b${id}: \\{ x: ${x}, y: ${y} \\}`), `pin ${id} should carry its day-map seed (${x}, ${y}) in the single coordinate truth source`);
  }

  // Week glyph, hub-aligned "controlled top" position (overlay: no extra grid row so the canvas
  // vertical budget stays intact).
  assert.match(mapBlock, /<header class="academy-map-topbar">[\s\S]*<span class="academy-map-sun-glyph"[\s\S]*<span class="academy-map-week" id="academy-map-week">/, 'academy map should carry a week glyph in a top strip');
  assert.match(css, /\.academy-map-topbar\s*\{[\s\S]*position:\s*absolute[\s\S]*\}/, 'the week glyph strip is absolutely overlaid so it never consumes the canvas height budget');
  assert.match(css, /\.academy-map-sun-glyph\s*\{[\s\S]*radial-gradient[\s\S]*var\(--am-night-/, 'the week glyph is a CSS celestial disc built from night tokens (no art asset)');

  // Left 5-category rail → info drawer, hub grammar, academy-map icons.
  const railBlock = mapBlock.match(/<nav class="academy-map-category-rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
  for (const category of ['self', 'buddy', 'enemy', 'inventory', 'money']) {
    assert.match(railBlock, new RegExp(`data-am-category="${category}"[\\s\\S]*?/canonical/academy_map/icons/${category}\\.png`), `rail should expose the fixed ${category} category with its academy_map icon`);
  }
  assert.match(mapBlock, /id="academy-map-info-popup"[\s\S]*id="academy-map-info-popup-icon"[\s\S]*id="academy-map-info-popup-title"[\s\S]*id="academy-map-info-popup-body"/, 'academy map should carry its own info drawer (icon + title + body)');
  assert.match(mapBlock, /data-am-popup-close="true"/, 'the drawer should keep backdrop + close dismissal');

  // 9-slice gold framing + calibratable corner ornaments (real offset declarations, no var() fallback).
  assert.match(mapBlock, /<div class="academy-map-frame" aria-hidden="true"><\/div>/, 'the canvas should carry a dedicated 9-slice frame overlay element');
  assert.match(css, /\.academy-map-frame\s*\{[\s\S]*border-image-source:\s*url\('\/canonical\/academy_map\/ui\/panel_9slice\.png'\)[\s\S]*border-image-slice:\s*100/, 'the frame should be a panel_9slice border-image 9-slice');
  for (const [corner, asset] of [['tl', 'corner_01'], ['tr', 'corner_02'], ['bl', 'corner_02'], ['br', 'corner_01']]) {
    assert.match(mapBlock, new RegExp(`academy-map-corner-${corner}" src="/canonical/academy_map/ui/${asset}\\.png"`), `corner ${corner} should place a ${asset} ornament`);
    assert.match(css, new RegExp(`\\.academy-map-corner-${corner}\\s*\\{[\\s\\S]*var\\(--am-corner-${corner}-dx\\)[\\s\\S]*var\\(--am-corner-${corner}-dy\\)`), `corner ${corner} offset should be a consumed calibration custom property (picked up by ?calibrate=academy-map in task B)`);
  }
  assert.match(css, /#academy-map-screen\s*\{[\s\S]*?--am-corner-tl-dx:\s*0px;[\s\S]*?--am-corner-br-dy:\s*0px;[\s\S]*?\}/, 'corner offsets should be real 0px declarations (no var() fallback) so calibration can bake confirmed values');

  // Night token layer is a screen-scoped set (deep-night / silver / starlight), distinct from and NOT reading
  // --routing-* / --cd-night-*; it mirrors the --routing-* family but is self-owned. The shared shell surface tokens
  // are untouched (asserted elsewhere), so the CSS below is consumed via --am-night-* only.
  // The declaration block is bounded to the single #academy-map-screen { ... } rule; asserting the concrete
  // night values here proves the layer is self-owned (it carries the --routing-* family values itself rather
  // than reading another screen's --routing-* scope).
  const academyMapTokenBlock = css.match(/#academy-map-screen\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(academyMapTokenBlock, /--am-night-0:\s*#05060f;[\s\S]*?--am-night-silver:\s*#cdd6ea;[\s\S]*?--am-night-starlight:\s*#9fb4ff;[\s\S]*?--am-night-panel-strong:\s*rgb\(9 12 26 \/ 0\.82\);/, 'academy map should declare its own night token layer (deep-night / silver / starlight) with the mirrored --routing-* family values');
  assert.doesNotMatch(academyMapTokenBlock, /var\(--routing-|var\(--cd-night-/, 'the map night token block must carry its own values, never read another screen\'s --routing-* / --cd-night-* declarations');
  assert.match(css, /\.academy-map-info-popup-card\s*\{[\s\S]*background:\s*var\(--am-night-panel-strong\)/, 'the info drawer is painted from the map night token layer (test-by-token), not --routing-* / --cd-night-*');
  assert.match(css, /\.academy-map-info-popup\[hidden\]\s*\{[\s\S]*display:\s*none/, 'the info drawer keeps the [hidden] display guard');

  // 外殻の廃止: this screen overrides the SHARED windowed-shell chrome (border / radius / bigframe fill / shadow)
  // so the map is full-bleed on a deep-night ground — no "big window on a blue background". The override is
  // scoped to #academy-map-screen so the shared .academy-map-shell base (used by conversation-session / shop /
  // training) is untouched (their windowed-frame contract is asserted elsewhere and stays byte-equal).
  const nightShellOverride = css.match(/#academy-map-screen \.academy-map-shell\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(nightShellOverride, '', 'the map screen should carry a scoped shell override that strips the windowed-card chrome');
  assert.match(nightShellOverride, /border:\s*0/, 'the map screen shell drops the shared gold big-frame border');
  assert.match(nightShellOverride, /border-radius:\s*0/, 'the map screen shell drops the rounded-window radius (full-bleed edge)');
  assert.match(nightShellOverride, /box-shadow:\s*none/, 'the map screen shell drops the windowed-card drop shadow');
  assert.match(nightShellOverride, /background:[\s\S]*linear-gradient\(160deg, var\(--am-night-1\), var\(--am-night-0\) 62%\)/, 'the map screen shell paints the deep-night ground from the night token layer (scrim gradient + starlight glow), not the shared --surface-bigframe / --surface-map-shell window fill');
  assert.doesNotMatch(nightShellOverride, /var\(--surface-bigframe\)|var\(--surface-map-shell\)|var\(--border-warm\)/, 'the full-bleed map ground must not reuse the shared windowed-shell fill/border tokens');

  // Rail stays usable while the drawer is open: it is layered above the info popup (z-index:6) so a real
  // pointer can switch category-to-category without dismissing first (hub switch-while-open grammar).
  const infoPopupZ = css.match(/\.academy-map-info-popup\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1];
  const railZ = css.match(/\.academy-map-category-rail\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1];
  assert.ok(infoPopupZ && railZ && Number(railZ) > Number(infoPopupZ), `the category rail (z-index ${railZ}) must sit above the info drawer overlay (z-index ${infoPopupZ}) so the rail stays clickable while the drawer is open`);
  assert.match(css, /\.academy-map-category-rail\s*\{[\s\S]*position:\s*relative[\s\S]*z-index:/, 'the rail is a positioned stacking layer above the drawer backdrop');

  // Arrival settle-in landing (dark → normal opacity/filter), reduced-motion aware. The is-day-arriving class
  // and academy-map-day-arrive keyframe names are kept because app.js (untouched map mechanics) drives them.
  assert.match(css, /@keyframes academy-map-day-arrive\s*\{[\s\S]*opacity:\s*0\.55[\s\S]*opacity:\s*1/, 'arrival should settle the map in from dark to its resting brightness');
  assert.match(css, /#academy-map-screen\.is-day-arriving\s+\.academy-map-canvas\s*\{[\s\S]*animation:\s*academy-map-day-arrive 600ms/, 'the landing plays on the canvas for ~600ms');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*#academy-map-screen\.is-day-arriving\s+\.academy-map-canvas\s*\{[\s\S]*animation:\s*none/, 'reduced motion disables the landing animation');

  // Week source is the shared fail-fast helper; showing the map renders the week + plays the landing without
  // changing placement/transition mechanics.
  assert.match(js, /import \{[^}]*resolveConversationStageInfoCategoryTitle[^}]*\} from '\.\/conversationStage\.js'/, 'app.js should reuse the shared category-title fail-fast helper');
  assert.match(js, /function renderAcademyMapWeek\(\)[\s\S]*conversationStageWeek\(currentRuntimeState\?\.elapsed_weeks\)[\s\S]*第\$\{week\}週 \/ \$\{ACADEMY_MAP_TOTAL_WEEKS\}/, 'the week glyph derives from the shared conversationStageWeek helper (fail-fast on invalid elapsed_weeks; no week-1 fabrication)');
  assert.match(js, /name === 'academy-map'[\s\S]*ensureAcademyMapCharacterAssignments\(\{ force: rerollAcademyMap \}\)[\s\S]*closeAcademyMapInfo\(\)[\s\S]*renderAcademyMapWeek\(\)[\s\S]*playAcademyMapDayArrival\(\)/, 'showing the academy map keeps the existing placement call and adds week render + day landing (drawer reset on show)');

  // Info drawer fail-fast is hub-shaped: unknown category throws, self/money/inventory data faults surface.
  assert.match(js, /function openAcademyMapInfo\(category\)[\s\S]*resolveConversationStageInfoCategoryTitle\(category, ACADEMY_MAP_INFO_CATEGORY_TITLES\)[\s\S]*academy map info popup nodes are missing/, 'openAcademyMapInfo validates the category against the fixed set and fails fast on missing nodes');
  assert.match(js, /function renderAcademyMapInfoCategory\(category, bodyEl\)[\s\S]*throw new Error\(`unknown academy map info category/, 'an unknown info category fails fast instead of rendering an empty drawer');
  const academyMapSelfRenderer = js.match(/self: \(\) => \{[\s\S]*?renderPlayerParametersInto\(parameters, '#academy-map-info-popup-body'\);[\s\S]*?\}/)?.[0] ?? '';
  assert.match(academyMapSelfRenderer, /academy map self info requires currentWorld\.player_parameters/, 'self reuses the shared player-parameter renderer over a validated source (fail-fast, no ?? {})');
  assert.match(js, /academy map money info requires currentInventory\.money/, 'money fails fast on a missing money source (no default-value fallback)');
  assert.match(js, /academy map inventory requires currentInventory\.items array/, 'inventory fails fast on a missing/invalid items array rather than reading as empty');
  // buddy is now resolved from the GET /api/relationships/buddy truth source (async: loading card → fetch →
  // stale-token + still-on-buddy guard), so a homunculus buddy renders instead of throwing as a dangling roster id.
  // A null buddy paints the map-scoped empty card; a corrupt buddy id throws (resolveBuddyPanelSubject, below).
  // enemy stays hub/day/map-同型 through the shared resolveInfoDrawerEnemies (enemy is selectable-only).
  assert.match(js, /function renderAcademyMapBuddyInfo\(bodyEl\) \{\s*loadAcademyMapBuddyInfo\(bodyEl\)\.catch\(reportError\);/, 'the map buddy category delegates to the async endpoint loader (a fetch failure → reportError)');
  assert.match(js, /async function loadAcademyMapBuddyInfo\(bodyEl\)[\s\S]*const view = await fetchBuddyView\(\)[\s\S]*popup\.dataset\.category !== 'buddy'[\s\S]*const subject = resolveBuddyPanelSubject\(view\)[\s\S]*if \(!subject\) \{[\s\S]*academyMapInfoEmptyCard\('バディー記録なし'/, 'a null buddy paints the map empty card only for a legitimately unset buddy (endpoint truth source, still-on-buddy guard)');
  assert.match(js, /function renderAcademyMapEnemiesInfo\(bodyEl\)[\s\S]*const enemies = resolveInfoDrawerEnemies\(\)[\s\S]*if \(!enemies\.length\) \{[\s\S]*academyMapInfoEmptyCard\('エネミー記録なし'/, 'enemy resolves through the shared resolver and shows the map empty card only when zero enemies are recorded (hub-同型)');
  assert.match(js, /function renderAcademyMapWeek\(\)[\s\S]*#academy-map-week is missing \(broken markup wiring\)/, 'the week glyph fails fast on missing markup instead of a silent no-op');
  assert.match(js, /function playAcademyMapDayArrival\(\)[\s\S]*#academy-map-screen is missing \(broken markup wiring\)/, 'the arrival landing fails fast on missing markup instead of a silent no-op');
  assert.match(js, /for \(const categoryButton of document\.querySelectorAll\('\.academy-map-category-button'\)\)[\s\S]*openAcademyMapInfo\(categoryButton\.dataset\.amCategory\)/, 'each rail button opens the matching category drawer');

  // The map has its OWN day-scoped info renderers/classes (so it binds to --am-*, not the routing/day layers),
  // mirroring how conversation-day duplicated the presentation to keep token layers separate.
  assert.match(js, /function academyMapBuddyHeroCard\(subject\)[\s\S]*academy-map-info-buddy-card/, 'buddy content is painted with academy-map-scoped classes');
  assert.match(js, /function renderAcademyMapMoneyInfo\(bodyEl, money\)[\s\S]*academy-map-info-money-card/, 'money content is painted with academy-map-scoped classes');
});

test('the three 昼スタイル info drawers fail fast on a corrupt buddy id / dangling enemy id instead of collapsing it to an empty card (routing hub / conversation-day / academy-map)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // buddy: a single shared resolver (resolveBuddyPanelSubject) backs all three drawers off the GET
  // /api/relationships/buddy truth source, so the empty-vs-corrupt split is identical (同型) rather than
  // re-decided per screen. A null buddy → the empty sentinel; a 'character'-kind id that does not resolve in the
  // roster → throw (corrupt state, no empty-card collapse); a 'homunculus'-kind buddy → the homunculus subject
  // (its display fields come from the endpoint, not the roster).
  const buddyResolver = js.match(/function resolveBuddyPanelSubject\(view\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buddyResolver, '', 'resolveBuddyPanelSubject should exist as the shared buddy resolver');
  assert.match(buddyResolver, /if \(view\.buddy === null\) return null;/, 'a null buddy is a legitimate empty state (returns null, not a throw)');
  assert.match(buddyResolver, /if \(buddy\.kind === 'character'\) \{[\s\S]*const roster = selectableCharacters\.find\(\(character\) => character\.character_id === buddy\.character_id\)[\s\S]*if \(!roster\) \{[\s\S]*throw new Error\([\s\S]*corrupt relationship state/, 'a character-kind buddy id that does not resolve in the roster throws (corrupt), it is not collapsed to an empty card');
  assert.match(buddyResolver, /return \{ kind: 'homunculus', characterId: buddy\.character_id, homunculus: buddy \};/, 'a homunculus-kind buddy resolves from the endpoint fields (not the selectable roster)');

  const enemyResolver = js.match(/function resolveInfoDrawerEnemies\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(enemyResolver, '', 'resolveInfoDrawerEnemies should exist as the shared enemy resolver');
  // Zero recorded enemies → empty array (legitimate empty state), never a throw.
  assert.match(enemyResolver, /const enemyIds = selectedAcademyEnemyCharacterIds\(\)[\s\S]*if \(enemyIds\.size === 0\) return \[\];/, 'zero recorded enemies are a legitimate empty state (returns [], not a throw)');
  // ANY recorded enemy id that does not resolve → throw (no partial display, no silent skip of the dangling id).
  assert.match(enemyResolver, /for \(const enemyId of enemyIds\) \{[\s\S]*if \(!selectableCharacters\.some\(\(character\) => character\.character_id === enemyId\)\) \{[\s\S]*throw new Error\([\s\S]*dangling relationship state/, 'any recorded enemy id that does not resolve throws (no partial display / silent skip of dangling ids)');
  assert.match(enemyResolver, /return selectableCharacters\.filter\(\(character\) => enemyIds\.has\(character\.character_id\)\);/, 'the resolved enemy list keeps selectable-roster order (byte-equal to the prior resolved render)');

  // All three buddy drawers delegate to an async endpoint loader (loading card → fetch → stale-token +
  // still-on-buddy guard → resolveBuddyPanelSubject), and all three enemy drawers route through the shared
  // resolveInfoDrawerEnemies (同型), so none re-implements a per-screen behavior.
  for (const [buddyRenderer, buddyLoader, enemyRenderer] of [
    ['renderRoutingHubBuddyInto', 'loadRoutingHubBuddyInto', 'renderRoutingHubEnemiesInto'],
    ['renderConversationDayBuddyInto', 'loadConversationDayBuddyInto', 'renderConversationDayEnemiesInto'],
    ['renderAcademyMapBuddyInfo', 'loadAcademyMapBuddyInfo', 'renderAcademyMapEnemiesInfo']
  ]) {
    const buddyFn = js.match(new RegExp(`function ${buddyRenderer}\\(bodyEl\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert.match(buddyFn, new RegExp(`${buddyLoader}\\(bodyEl\\)\\.catch\\(reportError\\)`), `${buddyRenderer} delegates to the async endpoint loader (errors → reportError)`);
    const buddyLoaderFn = js.match(new RegExp(`async function ${buddyLoader}\\(bodyEl\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert.match(buddyLoaderFn, /const view = await fetchBuddyView\(\)[\s\S]*popup\.dataset\.category !== 'buddy'[\s\S]*const subject = resolveBuddyPanelSubject\(view\);[\s\S]*if \(!subject\) \{/, `${buddyLoader} resolves the buddy through the shared endpoint resolver (null → empty card, corrupt → throw)`);
    const enemyFn = js.match(new RegExp(`function ${enemyRenderer}\\(bodyEl\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert.match(enemyFn, /const enemies = resolveInfoDrawerEnemies\(\);[\s\S]*if \(!enemies\.length\) \{/, `${enemyRenderer} resolves enemies through the shared resolver (dangling → throw, zero recorded → empty card)`);
  }

  // The dangling throw must ride the existing reportError path (Goal 1), not escape as an uncaught handler
  // error. Each of the three category rails wraps its synchronous drawer-open in try { … } catch reportError,
  // so a dangling buddy/enemy id surfaces through the standard error banner (same 流儀 as the character-popup open).
  assert.match(js, /for \(const categoryButton of document\.querySelectorAll\('\.academy-map-category-button'\)\)[\s\S]*try \{ openAcademyMapInfo\(categoryButton\.dataset\.amCategory\); \} catch \(error\) \{ reportError\(error\); \}/, 'the academy-map rail routes an openAcademyMapInfo throw (dangling buddy/enemy / unknown category) to reportError');
  assert.match(js, /for \(const button of document\.querySelectorAll\('\.routing-hub-category-button'\)\)[\s\S]*try \{ routingHubStage\.openInfo\(button\.dataset\.routingCategory\); \} catch \(error\) \{ reportError\(error\); \}/, 'the routing-hub rail routes an openInfo throw (dangling buddy/enemy / unknown category) to reportError');
  assert.match(js, /for \(const button of document\.querySelectorAll\('\.conversation-day-category-button'\)\)[\s\S]*try \{ conversationDayStage\.openInfo\(button\.dataset\.dayCategory\); \} catch \(error\) \{ reportError\(error\); \}/, 'the conversation-day rail routes an openInfo throw (dangling buddy/enemy / unknown category) to reportError');
});

test('pin hover shows one stage tooltip with present-character chips and drops the duplicate native title popup', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Requirement 1: the only hover popup is the single rich tooltip. The browser-native
  // name-only tooltip (button.title) is removed so two popups no longer stack on one pin.
  const renderMapFn = js.match(/function renderAcademyMap\(field\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(renderMapFn, '', 'renderAcademyMap should exist');
  assert.doesNotMatch(renderMapFn, /button\.title\s*=/, 'map pins must not set the native title attribute, which renders a redundant name-only browser tooltip beside the rich hover tooltip');
  assert.match(renderMapFn, /button\.setAttribute\('aria-label',/, 'pins should keep an aria-label for assistive tech even after dropping the visible native title tooltip');

  // The single tooltip carries the present-character section directly under the description.
  const mapBlock = html.match(/<section id="academy-map-screen"[\s\S]*?<section id="field-screen"/)?.[0] ?? '';
  const mapCanvas = mapBlock.match(/<div class="academy-map-canvas"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/)?.[0] ?? '';
  assert.match(mapCanvas, /id="academy-map-hover-stage"[\s\S]*id="academy-map-hover-description"[\s\S]*id="academy-map-hover-occupants"[\s\S]*id="academy-map-hover-occupants-names"/, 'the present-character chips should live inside the same hover tooltip, after the stage name and description');
  assert.match(mapCanvas, /id="academy-map-hover-occupants"[^>]*hidden/, 'the occupants row should start hidden so it only appears when a stage actually has present characters');

  // Requirement 4: both maps reuse one mechanism. The popup occupant list and the companion
  // screen pull from the same stageOccupantsFor helper, which is the single region branch point.
  assert.match(js, /function stageOccupantsFor\(location\)[\s\S]*mapLocationRegion\(location\) === 'sanrin'[\s\S]*\? sanrinCreatureCandidatesFor\(location\.id\)[\s\S]*: assignedAcademyMapCharactersFor\(location\.id\)/, 'one shared helper resolves who is present per stage for both academy and sanrin regions');
  const hoverOccupantsFn = js.match(/function renderAcademyMapHoverOccupants\(location\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(hoverOccupantsFn, '', 'a dedicated hover-occupants renderer should exist');
  assert.match(hoverOccupantsFn, /const present = stageOccupantsFor\(location\)/, 'the hover popup should read present characters from the same shared helper the companion screen uses');

  // Empty stages must hide the chip row rather than fabricate or zero-fill it (fail-fast on no data).
  assert.match(hoverOccupantsFn, /if \(!present\.length\)\s*\{[\s\S]*occupants\.hidden = true[\s\S]*names\.replaceChildren\(\)[\s\S]*return/, 'a stage with zero present characters should hide the occupants row instead of inventing names');
  assert.match(hoverOccupantsFn, /chip\.textContent = character\.display_name/, 'each present character should be shown by its authored display name');
  assert.match(hoverOccupantsFn, /character\.character_id === buddyCharacterId[\s\S]*enemyCharacterIds\.has\(character\.character_id\)/, 'present-character chips should reflect the same runtime buddy/enemy state as the pin glow');

  // The popup renderer is wired into the single shared hover-preview updater used by both maps.
  assert.match(js, /function updateAcademyMapHoverPreview\(location, point = null\)[\s\S]*renderAcademyMapHoverOccupants\(location\)[\s\S]*positionAcademyMapHoverTooltip\(tooltip, point\)/, 'the shared hover-preview updater should populate the occupant chips for whichever map region is active, then position the tooltip');

  // Chips are tokenized (test-by-token), not literal-colored, and keep the warm-gold border language.
  const chipCss = cssRuleBlock(css, '.academy-map-hover-occupant-chip');
  assert.notEqual(chipCss, '', 'occupant chips should have a dedicated chrome rule');
  assert.match(chipCss, /border:\s*1px solid rgb\(var\(--c-gold\) \/ 0\.42\)[\s\S]*border-radius:\s*var\(--radius-pill\)[\s\S]*background:\s*var\(--surface-chip\)/, 'occupant chips should consume the warm-gold border, pill radius, and shared chip surface tokens');
  assertNoCoolOrSoftBorderToken(chipCss, 'occupant chip');
  assert.match(css, /\.academy-map-hover-occupant-chip\.is-buddy[\s\S]*color:\s*var\(--text-buddy-badge\)[\s\S]*background:\s*var\(--surface-buddy-badge\)/, 'buddy chips should reuse the buddy badge tokens');
  assert.match(css, /\.academy-map-hover-occupant-chip\.is-enemy[\s\S]*color:\s*var\(--text-enemy\)[\s\S]*background:\s*var\(--surface-enemy-badge\)/, 'enemy chips should reuse the enemy badge tokens');
  assert.match(cssRuleBlock(css, '.academy-map-hover-occupants'), /border-top:\s*1px solid rgb\(var\(--c-gold\) \/ 0\.22\)/, 'the occupants row should be divided from the description with the warm-gold hairline');
});

test('academy map offers a free 学院/山林 region toggle that re-skins the same map screen', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const mapBlock = html.match(/<section id="academy-map-screen"[\s\S]*?<section id="field-screen"/)?.[0] ?? '';
  const mapHero = mapBlock.match(/<div class="academy-map-hero">[\s\S]*?<div class="academy-map-canvas"/)?.[0] ?? '';
  // Toggle lives in the map hero, not as a forbidden right-side status card.
  assert.match(mapHero, /class="academy-map-region-toggle"[\s\S]*id="academy-map-region-academy"[^>]*data-map-region="academy"[^>]*aria-pressed="true"[\s\S]*>学院<[\s\S]*id="academy-map-region-sanrin"[^>]*data-map-region="sanrin"[^>]*aria-pressed="false"[\s\S]*>山林</, 'map hero should host a 学院/山林 region toggle with the academy region selected by default');
  assert.doesNotMatch(mapHero, /academy-map-status-card|TURN STAGE/, 'the region toggle must not reintroduce a right-side information card in the map hero');
  assert.match(mapBlock, /<p id="academy-map-lead">/, 'map hero lead copy should be addressable so it can be re-skinned per region');

  // Region is a free view switch: it re-renders the map, it does not move the player.
  assert.match(js, /let activeMapRegion = 'academy'/, 'browser should track the active map region, defaulting to the academy');
  assert.match(js, /function setActiveMapRegion\(region\)[\s\S]*if \(nextRegion === activeMapRegion\) return[\s\S]*activeMapRegion = nextRegion[\s\S]*renderAcademyMap\(currentField\)/, 'switching region should re-render the map in place');
  assert.doesNotMatch(js.match(/function setActiveMapRegion\(region\)[\s\S]*?\n\}/)?.[0] ?? '', /moveToLocation|showAcademyLoadingScreenUntilReady|refresh\(\)/, 'region switch must stay free — it must not move the player, consume a turn, or hit the move/refresh path');
  assert.match(js, /\.academy-map-region-button[\s\S]*addEventListener\('click', \(\) => setActiveMapRegion\(regionButton\.dataset\.mapRegion\)\)/, 'each region toggle button should switch the active region on click');
  assert.match(js, /const sanrinMapStagePinCoordinates = \{[\s\S]*sanrin_trailhead: \{ x: 29\.9, y: 79\.3 \}[\s\S]*sanrin_conifer_forest: \{ x: 77\.5, y: 72\.3 \}[\s\S]*sanrin_stream_bank: \{ x: 55\.4, y: 71\.3 \}[\s\S]*sanrin_mossy_shrine: \{ x: 79, y: 22\.3 \}/, 'the 山林 stages should have their own pin coordinate table with the calibrated percentage coordinates, separate from the frozen academy coordinates');
  assert.match(js, /function applyAcademyMapRegionChrome\(region = activeMapRegion\)[\s\S]*canvas\.dataset\.mapRegion = definition\.id/, 'region chrome should stamp the active region onto the canvas so CSS can swap the overview background');

  // Sanrin background is overridden only for the sanrin region, leaving the frozen academy canvas rule intact.
  assert.match(css, /\.academy-map-canvas\[data-map-region="sanrin"\]\s*\{[\s\S]*url\('\/canonical\/backgrounds\/sanrin_overview_map\.jpg'\)/, 'sanrin region should swap the overview map background to the sanrin asset path');
  assert.match(css, /#academy-map-screen \.academy-map-hero\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/, 'the map-screen hero should reserve a right-edge column for the region toggle without altering the shared hero layout');
  assert.match(css, /\.academy-map-region-button\.is-active\s*\{[\s\S]*background:\s*rgb\(var\(--c-gold\) \/ 0\.20\)/, 'the selected region button should read as active with the warm-gold fill');
});

test('sanrin map exposes a 採取 special node that opens a 購買-styled gathering screen listing points, stock, and collect actions', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The 採取 node is a sanrin-only special node mirroring the academy 購買 node, never a normal conversation stage.
  assert.match(js, /const SANRIN_MAP_GATHERING_NODE_ID = 'sanrin_gathering'/, 'gathering access should declare a stable special-node id like the shop node');
  assert.match(js, /function sanrinMapGatheringNode\(\)[\s\S]*id: SANRIN_MAP_GATHERING_NODE_ID[\s\S]*display_name: '採取'/, 'gathering access should be modeled as a dedicated sanrin-map special node');
  // The 採取 node owns a dedicated stage-preview background just like 購買 owns background_031, so the
  // map-opened STAGE PREVIEW image is never blank. Both background fields must consume the canonical asset url.
  assert.match(js, /const SANRIN_GATHERING_BACKGROUND_URL = '\/canonical\/backgrounds\/sanrin_background_gathering\.jpg'/, 'the gathering node should declare a dedicated stage-preview background asset url like the shop node');
  assert.match(js, /function sanrinMapGatheringNode\(\)[\s\S]*background_url: SANRIN_GATHERING_BACKGROUND_URL,[\s\S]*background_source_image_url: SANRIN_GATHERING_BACKGROUND_URL/, 'the gathering node must wire its dedicated background to both fields so the stage preview image is not blank');
  assert.match(js, /function isSanrinMapGatheringNode\(nodeOrId\)[\s\S]*nodeId === SANRIN_MAP_GATHERING_NODE_ID/, 'the map should detect the special gathering node explicitly');
  assert.match(js, /const sanrinMapStagePinCoordinates = \{[\s\S]*sanrin_mossy_shrine:[\s\S]*sanrin_gathering: \{ x: 49, y: 28 \}/, 'the gathering node should have a fixed pin in the sanrin coordinate table');
  assert.match(js, /function academyMapRegionRenderableNodes\(region = activeMapRegion, locations = academyMapLocations\(\)\)[\s\S]*region === 'sanrin'[\s\S]*\[\.\.\.academyMapConversationLocations\(regionLocations\), sanrinMapGatheringNode\(\)\]/, 'the sanrin region should append the 採取 special node after its conversation stages');
  assert.match(js, /async function goToAcademyMapLocation\(\)[\s\S]*if \(isSanrinMapGatheringNode\(academyMapSelectedLocationId\)\) \{[\s\S]*document\.querySelector\('#academy-map-location-dialog'\)\.close\(\);[\s\S]*showScreen\('gathering'\);[\s\S]*return;[\s\S]*\}/, 'gathering node action should close the shared dialog and open the gathering screen instead of moving to a conversation stage');

  // The gathering screen is its own academy-styled route registered like the shop, with a fresh stock fetch on entry.
  assert.match(js, /gathering: document\.querySelector\('#gathering-screen'\)/, 'the gathering screen should be registered in the screen map');
  assert.match(js, /showScreen\(name, \{ rerollAcademyMap = false, skipDungeonRefresh = false \} = \{\}\)[\s\S]*name === 'gathering'[\s\S]*refreshGathering\(\)/, 'opening the gathering screen should refresh its stock state');
  assert.match(js, /function renderGathering\(gathering = currentGathering\)[\s\S]*#gathering-points[\s\S]*collectGatheringPoint\(point\.point_id\)/, 'gathering renderer should list points and wire a per-point collect action');
  assert.match(js, /async function refreshGathering\(\)[\s\S]*getJson\('\/api\/gathering'\)[\s\S]*renderGathering/, 'gathering refresh should fetch the current points/stock and render them');
  assert.match(js, /async function collectGatheringPoint\(pointId\)[\s\S]*postJson\('\/api\/gathering\/collect', \{ point_id: pointId \}\)[\s\S]*renderGathering\(result\.gathering\)[\s\S]*renderInventory\(result\.inventory\)[\s\S]*renderShopInventoryColumn\(result\.inventory\)[\s\S]*showEconomyMessage/, 'collecting should post to the collect API, re-render points and inventory, and toast the result');
  assert.match(js, /async function collectGatheringPoint\(pointId\)[\s\S]*error\?\.payload\?\.error === 'gathering_stock_empty'[\s\S]*refreshGathering\(\)[\s\S]*showEconomyMessage/, 'an empty-stock collect should be handled gracefully with a refresh and a toast, not a raw error');
  assert.match(js, /#gathering-back-to-map[\s\S]*showScreen\('academy-map', \{ rerollAcademyMap: false \}\)/, 'gathering screen should return to the map without rerolling hidden assignments');

  // Markup: a dedicated screen plus the dev-toolbar tab, rendered full-screen-direct in the conversation-day 黒夜
  // taste (a 山林 stage banner over the obsidian ground, no shell window) — same family as the 調合/依頼 day screens.
  assert.match(html, /data-screen="gathering"[^>]*>採取</, 'the topbar should expose a 採取 route like the other screens');
  const gatheringBlock = html.match(/<section id="gathering-screen"[\s\S]*?<\/main>/)?.[0] ?? '';
  assert.match(gatheringBlock, /class="academy-gathering-frame"[\s\S]*class="academy-gathering-stage"[\s\S]*class="academy-gathering-stage-image"[\s\S]*class="academy-gathering-hero"[\s\S]*class="academy-gathering-hero-copy"[\s\S]*id="gathering-title"[^>]*>採取<[\s\S]*id="gathering-back-to-map"[^>]*>山林マップに戻る</, 'gathering screen should be a full-screen-direct day frame with a stage-image hero and a sanrin-map return action (no shell window)');
  assert.doesNotMatch(gatheringBlock, /academy-map-shell/, 'gathering screen should not wrap itself in the shared academy map shell (全画面直接・shell 外殻なし)');
  assert.match(gatheringBlock, /class="academy-gathering-board"[\s\S]*class="academy-gathering-panel"[\s\S]*id="gathering-points" class="economy-item-list academy-gathering-item-list"/, 'gathering board should host a single day panel with the points list');
  assert.doesNotMatch(gatheringBlock, /academy-shop-money-card|shop-inventory-money/, 'gathering screen should not carry the shop money badge — selling stays in the shop');

  // CSS: the gathering screen carries its own 黒曜＋琥珀 (--gathering-*) day token layer (like 調合/依頼) in a
  // single-column board with internal scroll — test-by-token, no literal color pin, no shared academy shell tokens.
  assert.match(css, /body:has\(#gathering-screen\.active\) \.layout\s*\{[\s\S]*?height:\s*calc\(100dvh - var\(--runtime-topbar-height, 88px\)\)[\s\S]*?padding:\s*0;[\s\S]*?overflow:\s*hidden/, 'gathering screen should pin the main layout to the viewport like other academy surfaces, edge-to-edge (padding:0) so the flat obsidian screen fills it with no navy-gradient border inset (direct-background standard)');
  assert.match(css, /#gathering-screen\.active\s*\{[\s\S]*display:\s*grid[\s\S]*height:\s*100%[\s\S]*min-height:\s*0/, 'active gathering screen should fill the bounded layout height');
  assert.match(css, /#gathering-screen\s*\{[\s\S]*--gathering-bg-0:\s*#0c0e13[\s\S]*--gathering-amber:\s*#f0b24a[\s\S]*--gathering-panel:[\s\S]*color:\s*var\(--gathering-ink\)[\s\S]*background:\s*var\(--gathering-bg-0\)/, 'gathering screen should declare and consume its own 黒曜＋琥珀 (--gathering-*) day token layer (conversation-day テイスト・調合/依頼と同族)');
  assert.match(css, /\.academy-gathering-stage-image\s*\{[\s\S]*url\('\/canonical\/backgrounds\/sanrin_background_gathering\.jpg'\)/, 'the gathering hero should frame the 山林 gathering scene as its day stage image under a legibility veil');
  assert.match(css, /\.academy-gathering-stage::before,\s*\.academy-gathering-stage::after\s*\{[\s\S]*url\('\/canonical\/conversation_day\/ui\/corner_02\.png'\)/, 'the gathering stage frame should carry the conversation-day corner ornaments so the content screens read as one visual language');
  assert.match(css, /\.academy-gathering-panel\s*\{[\s\S]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)[\s\S]*border:\s*1px solid var\(--gathering-line\)[\s\S]*background:\s*linear-gradient\(180deg, var\(--gathering-panel-strong\), var\(--gathering-panel\)\)[\s\S]*box-shadow:\s*inset 0 0 0 1px var\(--gathering-inner-ring\)/, 'the gathering board panel should reserve heading rows, let only the points area stretch, and consume the obsidian --gathering-* surface tokens');
  assert.match(css, /\.academy-gathering-board\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*min-height:\s*0/, 'gathering board should be a single full-width column');
  assert.match(css, /#gathering-points\s*\{[\s\S]*overflow-y:\s*auto/, 'the points list should scroll internally instead of growing the page');
  // The return button and the point cards are repainted to the day skin via id-scoped overrides (shared bases stay
  // byte-equal), and the gathering section consumes no shared academy shell surface/border/shadow tokens.
  assert.match(css, /#gathering-screen \.academy-map-action-button\s*\{[\s\S]*border:\s*1px solid var\(--gathering-line-strong\)[\s\S]*background:\s*var\(--gathering-panel\)/, 'the sanrin-map return button should be id-scoped repainted to the --gathering-* day skin (the shared CTA base wears the old chrome)');
  assert.match(css, /#gathering-screen \.economy-item-card\s*\{[\s\S]*border:\s*1px solid var\(--gathering-line\)[\s\S]*background:\s*var\(--gathering-card\)/, 'the shared economy point cards should be id-scoped repainted to the obsidian --gathering-* skin inside the gathering screen');
  const gatheringCss = css.match(/\/\* ── 採取画面（#gathering-screen 専用）[\s\S]*?(?=\.training-options\s*\{)/)?.[0] ?? '';
  assert.ok(gatheringCss.length > 0, 'gathering CSS section should be extractable by its stable section header');
  assert.doesNotMatch(gatheringCss, /var\(--surface-panel\)|var\(--border-soft\)|var\(--shadow-academy-training-panel\)/, 'the gathering day restyle should not consume the shared academy shell surface/border/shadow tokens (全画面直接・独立トークン層)');
});

test('gathering point cards render the spot image and material icon when present and degrade gracefully when absent', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // JS: each point card shows its generated spot image only when the API provides one, so unwired/ungenerated points keep the old layout.
  assert.match(js, /if \(typeof point\.image === 'string' && point\.image\)[\s\S]*image\.className = 'academy-gathering-point-image'[\s\S]*image\.src = point\.image/, 'gathering cards should render the gathering-spot image guarded on point.image so a missing image is simply omitted');
  // JS: the material line carries the material icon only when present, falling back to the plain material text otherwise.
  assert.match(js, /if \(typeof material\.icon === 'string' && material\.icon\)[\s\S]*icon\.className = 'academy-gathering-material-icon'[\s\S]*icon\.src = material\.icon/, 'gathering cards should render the material icon guarded on material.icon so a missing icon is simply omitted');

  // CSS: spot image and material icon fill their frames with the day amber-hairline (--gathering-line) border.
  assert.match(css, /\.academy-gathering-point-image\s*\{[\s\S]*aspect-ratio:\s*16 \/ 9[\s\S]*object-fit:\s*cover[\s\S]*border:\s*1px solid var\(--gathering-line\)/, 'the gathering-spot image should fill a 16:9 frame with the day amber-hairline border');
  assert.match(css, /\.academy-gathering-material-line\s*\{[\s\S]*display:\s*flex[\s\S]*align-items:\s*center/, 'the material line should lay the icon and text out in a centered flex row');
  assert.match(css, /\.academy-gathering-material-icon\s*\{[\s\S]*object-fit:\s*cover[\s\S]*border:\s*1px solid var\(--gathering-line\)/, 'the material icon should fill its square frame with the day amber-hairline border');
});

test('conversation partner popup caps each row at two candidates and wraps the rest', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');
  const companionBodyCss = cssRuleBlock(css, '.academy-map-companion-popup-body');
  assert.match(companionBodyCss, /display:\s*grid/, 'the conversation-partner candidate list should be a grid');
  assert.match(companionBodyCss, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, 'the 会話相手 popup should show at most two per row and wrap the third onward inside its bounded card');
  assert.doesNotMatch(companionBodyCss, /auto-fit|auto-fill/, 'the candidate list must not auto-fit an unbounded number of columns per row');
});
