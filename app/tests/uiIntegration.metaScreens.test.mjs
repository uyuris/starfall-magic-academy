import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';
import { CONVERSATION_POPUP_COOLDOWN_PRESETS } from '../src/server/conversationPopupSettingsApi.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('browser shell keeps legacy screens while hiding replaced topbar routes', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  for (const screen of ['title', 'slot-load', 'world', 'field', 'training', 'event', 'inventory', 'shop', 'debug', 'academy-map', 'academy-conversation-session', 'academy-room']) {
    assert.match(html, new RegExp(`id="${screen}-screen"`), `missing #${screen}-screen`);
  }
  for (const screen of ['title', 'slot-load', 'world', 'field', 'shop', 'debug', 'academy-map', 'academy-conversation-session', 'academy-room']) {
    assert.match(html, new RegExp(`data-screen="${screen}"`), `missing ${screen} tab`);
  }
  // The physical interaction screen and its tab are removed: field/creature/manual-event conversations
  // run on the conversation session screen now. Assert both traces are gone (no orphan screen/tab).
  assert.doesNotMatch(html, /id="interaction-screen"/, 'the standalone physical interaction screen must be removed once conversations run on the session screen');
  assert.doesNotMatch(html, /data-screen="interaction"/, 'the interaction tab must be removed with its screen');
  // The academy-companion screen and tab are removed: conversation-partner selection is a popup on the
  // academy map now, not a separate screen. Assert both traces are gone (no orphan screen/tab).
  assert.doesNotMatch(html, /id="academy-companion-screen"/, 'the standalone academy-companion screen must be removed once partner selection is a map popup');
  assert.doesNotMatch(html, /data-screen="academy-companion"/, 'the academy-companion tab must be removed with its screen');

  assert.match(html, /id="academy-map-screen" class="screen active"/, 'academy map should be the initial screen for normal debug/tuning access');
  assert.match(html, /id="title-screen" class="screen title-hero-screen"/, 'title should be available but not the initial screen');
  assert.match(html, /data-screen="debug"[\s\S]*>デバッグ<[\s\S]*data-screen="title"[\s\S]*>タイトル<[\s\S]*data-screen="academy-map" class="active"[\s\S]*>学院マップ</, 'title tab should sit between Debug and the initially active Academy Map');
  assert.match(html, /data-screen="academy-room"[\s\S]*>自室<[\s\S]*data-screen="slot-load"[^>]*>ロード</, 'topbar should expose a dedicated ロード route after the normal screen tabs');
  assert.match(html, /<section id="title-screen"[\s\S]*id="start-new-game"[\s\S]*最初から始める[\s\S]*id="open-load-screen"[\s\S]*ロード/, 'title screen should expose new-game and placeholder load actions');
  assert.match(html, /<section id="title-screen"[\s\S]*id="title-status"[\s\S]*aria-live="polite"/, 'title screen should expose a visible live status area for startup failures');
  assert.doesNotMatch(html, /id="open-load-screen"[^>]*disabled/, 'title load action should no longer be a disabled placeholder once the load screen exists');
  assert.match(js, /async function startNewGame\(\)[\s\S]*postJson\('\/api\/new-game'/, 'new game button should call the play-area initialization API');
  assert.match(js, /function setTitleActionStatus\(message, options = \{\}\)[\s\S]*#title-status/, 'front-end should expose a dedicated title status writer');
  assert.match(js, /function reportError\(error\)[\s\S]*#title-screen[^\n]*active[\s\S]*setTitleActionStatus\(/, 'runtime errors triggered from the title screen should become visible there instead of staying console-only');
  assert.match(js, /async function routePendingEventFromAcademyMap\(\)[\s\S]*refreshEventFlagStatus\(\)[\s\S]*pending_events[\s\S]*startAcademyConversationSessionFromPendingEvent\(autoStartFlag\.id\)/, 'academy map entry should detect a ready event and start it through the loading-aware academy conversation session route');
  assert.match(js, /async function startNewGame\(\)[\s\S]*showScreen\('academy-map', \{ rerollAcademyMap: true \}\)[\s\S]*await routePendingEventFromAcademyMap\(\)/, 'new game should enter the academy map route and then auto-start the opening event when it is ready');
  assert.match(js, /#start-new-game[\s\S]*startNewGame\(\)/, 'new game button should be wired');

  assert.match(html, /id="event-pending-list"/, 'event screen should expose a pending-event status list');
  assert.match(html, /id="event-empty-message"/, 'event screen should explain when no event is ready');
  assert.doesNotMatch(html, /id="complete-event"/);
  assert.doesNotMatch(html, /id="event-choices"/);
  assert.doesNotMatch(html, /<button data-screen="training"/, 'legacy training tab should be hidden from the topbar');
  assert.doesNotMatch(html, /<button data-screen="event"/, 'event tab should be hidden from the topbar');
  assert.doesNotMatch(html, /<button data-screen="inventory"/, 'inventory tab should be hidden from the topbar');
  assert.doesNotMatch(html, /data-screen="training">育成<\//, 'training tab should not keep the old 育成 label');
  assert.match(html, /data-screen="world"[\s\S]*>ワールド</, 'world tab should remain in the normal left-side group');
  assert.match(html, /data-screen="debug"[\s\S]*>デバッグ<[\s\S]*data-screen="title"[\s\S]*>タイトル<[\s\S]*data-screen="academy-map"[\s\S]*>学院マップ<[\s\S]*data-screen="academy-conversation-session"[\s\S]*>会話セッション<[\s\S]*data-screen="academy-room"[\s\S]*>自室</, 'academy room tab should sit to the right of academy conversation session, which now follows the academy map tab directly (no companion tab between them)');
  assert.match(html, /id="world-screen" class="screen"/, 'world settings should be its own tabbed screen');
  assert.match(html, /id="debug-screen" class="screen"/, 'debug panel should be its own tabbed screen instead of an always-visible aside');

  for (const id of [
    'start-new-game',
    'open-load-screen',
    'field-route-list',
    'academy-map-stage-layer',
    'academy-map-location-dialog',
    'academy-map-location-image',
    'academy-map-go-button',
    'academy-map-close-button',
    'academy-map-hover-stage',
    'academy-map-hover-description',
    'academy-map-hover-occupants',
    'academy-map-hover-occupants-names',
    'academy-map-companion-popup',
    'academy-map-companion-popup-title',
    'academy-map-companion-popup-stage',
    'academy-map-companion-popup-body',
    'academy-conversation-session-screen',
    'academy-conversation-session-location-name-button',
    'academy-conversation-session-location-detail-dialog',
    'academy-conversation-session-character-name-button',
    'academy-conversation-session-character-detail-dialog',
    'academy-conversation-session-character-standee',
    'academy-conversation-session-character-detail-standee',
    'academy-conversation-session-character-parameters',
    'academy-conversation-session-message-stream',
    'academy-conversation-session-player-input',
    'academy-conversation-session-run-conversation',
    'academy-conversation-session-end-conversation',
    'academy-room-title',
    'academy-room-money',
    'academy-room-player-parameters',
    'academy-room-buddy-card',
    'academy-room-enemy-count',
    'academy-room-enemy-list',
    'academy-room-item-count',
    'academy-room-inventory-items',
    'academy-room-start-training',
    'academy-room-open-load',
    'field-left-column',
    'field-location-detail-dialog',
    'field-current-location-button',
    'player-name',
    'world-description',
    'player-parameters-editor',
    'magic-parameter-presets',
    'ability-parameter-presets',
    'save-world-description',
    'character-selection-list',
    'character-prompt-description',
    'character-speaking-basis',
    'academy-conversation-session-character-parameters',
    'start-selected-character',
    'training-options',
    'training-player-parameters',
    'training-result',
    'academy-conversation-session-message-stream',
    'academy-conversation-session-player-input',
    'academy-conversation-session-run-conversation',
    'academy-conversation-session-end-conversation'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

test('bigframe target chrome uses one warm-gold border language with no cool or soft border tokens', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  for (const selector of [
    '.academy-map-shell:not(.academy-training-shell)',
    '.academy-map-status-card',
    '.academy-map-node',
    '.academy-map-node:focus-visible:not(:disabled)',
    '.academy-map-action-button',
    '.academy-map-action-button:hover:not(:disabled)',
    '.academy-companion-standee-frame',
    '.academy-companion-character-detail-info',
    '.academy-room-shell',
    '.academy-room-panel',
    '.academy-room-action-card',
    '.academy-room-action-card .academy-map-action-button',
  ]) {
    const block = cssRuleBlock(css, selector);
    assert.notEqual(block, '', `${selector} should have a dedicated chrome rule block`);
    assertNoCoolOrSoftBorderToken(block, selector);
  }
});

test('title screen is a toolbarless full-screen play entry while normal startup keeps the debug toolbar on academy map', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /<body>\s*<header class="topbar">/, 'normal startup should keep the topbar available before JS runs');
  assert.match(html, /<section id="academy-map-screen" class="screen active"/, 'normal startup should begin on the toolbar-visible academy map');
  assert.match(html, /<section id="title-screen" class="screen title-hero-screen"/, 'title is a toolbarless route, not the initial screen');
  const titleBlock = html.match(/<section id="title-screen"[\s\S]*?<section id="world-screen"/)?.[0] ?? '';
  assert.match(titleBlock, /<h2 id="title-title">STARFALL MAGIC ACADEMY<\/h2>/, 'title screen should display the requested English title');
  assert.doesNotMatch(titleBlock, /Starfall Magic Academy|星灯魔法学院 ADV|title-screen-lead|panel-help|霧の塔|新規開始はプレイ用領域/, 'title screen should remove all explanatory copy outside the requested title and buttons');
  assert.match(html, /class="title-screen-shell"/, 'title copy should not reuse the old app-card panel');
  assert.doesNotMatch(html, /<div class="title-screen-shell app-card">/, 'title screen should not keep the old generic app-card styling');
  assert.match(html, /id="start-new-game"[^>]*class="academy-map-action-button title-action-button"/, 'new-game button should use the gold-outline academy action button language');
  assert.match(html, /id="open-load-screen"[^>]*class="academy-map-action-button title-action-button"/, 'title load button should use the same gold-outline academy action button language');

  assert.match(css, /body\.title-screen-active\s+\.topbar\s*{\s*display:\s*none;\s*}/, 'title screen should hide the debug/testing topbar');
  assert.match(css, /body\.play-mode\s+\.topbar\s*{\s*display:\s*none;\s*}/, 'started gameplay should also hide the debug/testing topbar');
  assert.match(css, /body\.title-screen-active\s+\.layout[\s\S]*min-height:\s*100dvh/, 'title screen layout should use the full viewport');
  assert.match(css, /#title-screen\.active[\s\S]*min-height:\s*100dvh/, 'active title screen should not subtract topbar height');
  // Metaphysical-moonlight token layer: the meta screens (title + loading) declare the deep-night / silver /
  // starlight family in their OWN screen scope (never :root), so the routing / day / academy-shell layers stay
  // untouched. The title consumes those tokens; the old warm --surface-title-* / --btn-title-* tokens and the
  // daytime title.jpg reference are gone without a trace.
  assert.match(css, /#title-screen,\n#academy-loading-screen,\n#slot-load-screen,\n#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*--meta-silver-strong:\s*#eef3ff[\s\S]*--meta-line-strong:\s*rgb\(159 180 255 \/ 0\.5\)[\s\S]*--meta-panel-strong:\s*rgb\(9 12 26 \/ 0\.82\)[\s\S]*--meta-glow:\s*rgb\(159 180 255 \/ 0\.35\)[\s\S]*\}/, 'the meta screens should declare the moonlight token layer (silver / line / panel / glow) in their own screen scope');
  assert.match(css, /#title-screen,\n#academy-loading-screen,\n#slot-load-screen,\n#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*--meta-title-scrim:[\s\S]*--meta-title-glow:[\s\S]*--meta-load-scrim:[\s\S]*--meta-slot-scrim:[\s\S]*--meta-slot-glow:[\s\S]*--meta-settings-scrim:[\s\S]*--meta-settings-glow:[\s\S]*\}/, 'the meta token layer should define the title scrim / glow, loading scrim, slot-select scrim / glow, and settings scrim / glow gradient tokens');
  assert.doesNotMatch(css, /--surface-title-hero-scrim|--surface-title-hero-glow|--surface-title-shell|--surface-title-bigframe|--btn-title-bg/, 'the warm title tokens should be removed without a trace once the meta screens are moonlight');
  assert.match(css, /\.title-hero-screen\s*\{[\s\S]*background:[\s\S]*var\(--meta-title-scrim\),[\s\S]*url\('\/canonical\/title\/title_night\.jpg'\)/, 'title screen should use canonical/title/title_night.jpg with the tokenized moonlight scrim');
  assert.doesNotMatch(css, /url\('\/canonical\/title\/title\.jpg'\)/, 'the old daytime title art reference should be gone');
  assert.match(css, /\.title-hero-screen::before\s*\{[\s\S]*background:\s*var\(--meta-title-glow\)/, 'title hero glow should consume the moonlight title glow token');
  // Ambient: a silver starfield canvas behind the menu + slowly drifting decor, reduced-motion aware.
  assert.match(css, /\.title-starfield\s*\{[\s\S]*position:\s*absolute[\s\S]*pointer-events:\s*none/, 'the title should carry a full-bleed starfield canvas behind the menu');
  assert.match(css, /\.title-decor-1 \{ animation: title-decor-drift/, 'the title decor should drift slowly like the routing hub ambient');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.title-decor-1,[\s\S]*animation:\s*none/, 'the title decor drift should be disabled under reduced motion');
  const titleScreenShellCss = cssRuleBlock(css, '.title-screen-shell');
  assert.match(titleScreenShellCss, /width:\s*fit-content[\s\S]*margin:\s*0 0 clamp\(18px, 3\.4vw, 42px\) 0[\s\S]*padding:\s*clamp\(11px, 1\.75vw, 17px\)/, 'title copy frame should keep its dimensions while becoming the title route bigframe card');
  // Title card keeps the bigframe dimensions/radius + a backdrop blur so the moonlit art shows through, but
  // its chrome is re-skinned to the moonlight token layer: a silver filigree frame over the deep-night panel
  // with a starlight glow (var(--meta-*) only — no literal color pin).
  assert.match(titleScreenShellCss, /border:\s*1px solid var\(--meta-line-strong\)/, 'title card: silver filigree border');
  assert.match(titleScreenShellCss, /border-radius:\s*var\(--radius-frame\)/, 'title card: frame radius');
  assert.match(titleScreenShellCss, /background:\s*var\(--meta-panel-strong\)/, 'title card: deep-night moonlight panel so the art still reads behind it');
  assert.match(titleScreenShellCss, /box-shadow:\s*0 0 0 1px var\(--meta-line\), 0 18px 44px var\(--meta-shadow\), 0 0 22px var\(--meta-glow\)/, 'title card: moonlight starlight glow shadow (token-only)');
  assert.match(titleScreenShellCss, /backdrop-filter:\s*blur\(/, 'title card: backdrop blur for readability over the art');
  assert.doesNotMatch(titleScreenShellCss, /#[0-9a-fA-F]{3,6}|rgba?\(/, 'title card chrome must consume tokens only (no literal color pin)');
  assertNoCoolOrSoftBorderToken(titleScreenShellCss, 'title card');
  // Silver corner ornaments (reused routing PNGs) seat the four corners of the card.
  assert.match(css, /\.title-corner\s*\{[\s\S]*position:\s*absolute[\s\S]*filter:\s*drop-shadow\([^)]*var\(--meta-glow\)/, 'the title shell should carry silver-glow corner ornaments');
  const titleActionCss = cssRuleBlock(css, '.title-screen-shell .title-action-button');
  assert.match(titleActionCss, /min-width:\s*124px[\s\S]*justify-content:\s*center[\s\S]*font-size:\s*14px/, 'title actions should preserve direct sizing while adopting the moonlight chrome');
  assert.match(titleActionCss, /border:\s*1px solid var\(--meta-line-strong\)[\s\S]*background:\s*var\(--meta-panel\)[\s\S]*color:\s*var\(--meta-silver-strong\)/, 'title actions should adopt the moonlight silver filigree chrome');
  assert.match(css, /\.title-screen-shell \.title-action-button:hover:not\(:disabled\),\n\.title-screen-shell \.title-action-button:focus-visible \{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*box-shadow:\s*0 0 14px var\(--meta-glow\)/, 'title actions should flare a starlight border + glow on hover and focus-visible');
  assert.doesNotMatch(titleActionCss, /--btn-title-bg/, 'title actions should not reference the removed warm button fill token');

  // The title backdrop carries the ambient: a starfield canvas + reused routing decor PNGs; the shell reuses
  // the routing corner ornament art.
  assert.match(titleBlock, /<canvas id="title-starfield" class="title-starfield">/, 'title screen should host a starfield ambient canvas');
  assert.match(titleBlock, /class="title-decor title-decor-1" src="\/canonical\/routing\/decor\/decor_01\.png"/, 'title backdrop should reuse the routing decor art for the drifting ornaments');
  assert.match(titleBlock, /class="title-corner title-corner-tl" src="\/canonical\/routing\/ui\/corner_01\.png"/, 'title shell should reuse the routing corner ornament art');
  assert.match(css, /#title-screen\s*\{[\s\S]*?--title-corner-tl-dx:\s*-5px;[\s\S]*?--title-corner-tl-dy:\s*-7px;[\s\S]*?--title-corner-tr-dx:\s*6px;[\s\S]*?--title-corner-tr-dy:\s*-2px;[\s\S]*?--title-corner-bl-dx:\s*-6px;[\s\S]*?--title-corner-bl-dy:\s*2px;[\s\S]*?--title-corner-br-dx:\s*5px;[\s\S]*?--title-corner-br-dy:\s*6px;[\s\S]*?\}/, 'title corner offsets should be real declarations (no var() fallback) so ?calibrate=title can bake confirmed values');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    assert.match(css, new RegExp(`\\.title-corner-${corner}\\s*\\{[\\s\\S]*var\\(--title-corner-${corner}-dx\\)[\\s\\S]*var\\(--title-corner-${corner}-dy\\)`), `title corner ${corner} should consume its calibration custom properties`);
  }
  assert.match(css, /\.title-corner-tl \{[^}]*transform:\s*translate\(var\(--title-corner-tl-dx\), var\(--title-corner-tl-dy\)\);[^}]*\}/, 'title top-left keeps the reference orientation plus calibration translate');
  assert.match(css, /\.title-corner-tr \{[^}]*transform:\s*translate\(var\(--title-corner-tr-dx\), var\(--title-corner-tr-dy\)\) scale\(1, 1\);[^}]*\}/, 'title top-right is horizontally flipped from the previous mirrored state while keeping calibration first');
  assert.match(css, /\.title-corner-bl \{[^}]*transform:\s*translate\(var\(--title-corner-bl-dx\), var\(--title-corner-bl-dy\)\) scale\(-1, -1\);[^}]*\}/, 'title bottom-left is horizontally flipped from the previous vertical-only state while keeping calibration first');
  assert.match(css, /\.title-corner-br \{[^}]*transform:\s*translate\(var\(--title-corner-br-dx\), var\(--title-corner-br-dy\)\) scale\(-1, -1\);[^}]*\}/, 'title bottom-right remains unchanged');
  // The starfield ambient is the shared conversation-stage part, started on the title screen and stopped on leave.
  assert.match(js, /const titleStarfield = createStarfieldAmbient\(\{ canvasSelector: '#title-starfield'/, 'the title consumer should instantiate the shared starfield ambient over its own canvas');
  assert.match(js, /if \(name === 'title'\) titleStarfield\.start\(\)/, 'showScreen should start the title starfield when the title screen opens');
  assert.match(js, /if \(name !== 'title'\) titleStarfield\.stop\(\)/, 'showScreen should stop the title starfield when leaving the title screen');

  assert.match(js, /document\.body\.classList\.toggle\('title-screen-active',\s*name === 'title'\)/, 'showScreen should keep the title-active body class in sync');
  assert.match(js, /document\.body\.classList\.add\('play-mode'\)[\s\S]*showScreen\('academy-map'/, 'starting a new game should enter play mode before routing into gameplay');
});

test('meta screens (title + loading) share one metaphysical-moonlight layer: night backgrounds, scoped tokens, starfield ambient, and no image rotation', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Both meta backgrounds are the new night art; the old daytime title art and the rotating ig_* load art are gone.
  assert.match(css, /url\('\/canonical\/title\/title_night\.jpg'\)/, 'title should use the night background');
  assert.match(css, /url\('\/canonical\/load\/loading_night\.jpg'\)/, 'loading should use the night background');
  assert.doesNotMatch(css, /\/canonical\/title\/title\.jpg|\/canonical\/load\/ig_/, 'the old daytime title art and rotating load art references should be gone');
  assert.doesNotMatch(js, /\/canonical\/load\/ig_|academyLoadingImageUrls/, 'the rotating load image list should be gone from the script');

  // The moonlight token layer is declared on the two meta screen scopes only — never :root — so the routing /
  // day / academy-shell layers stay untouched and unreadable across scopes.
  const rootBlock = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(rootBlock, '', ':root block should be found');
  assert.doesNotMatch(rootBlock, /--meta-/, 'the meta-night tokens must not leak into :root');
  assert.match(css, /#title-screen,\n#academy-loading-screen,\n#slot-load-screen,\n#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*--meta-night-0:[\s\S]*--meta-silver:[\s\S]*--meta-starlight:[\s\S]*\}/, 'the meta-night token layer should be scoped to the title, loading, slot-load, settings, debug, world, and field screens plus the debug topbar');

  // Each meta screen hosts its own starfield ambient canvas, started/stopped by showScreen (shared part).
  assert.match(html, /<canvas id="title-starfield"/, 'the title should host a starfield canvas');
  assert.match(html, /<canvas id="academy-loading-starfield"/, 'the loading screen should host a starfield canvas');
  assert.match(js, /const titleStarfield = createStarfieldAmbient\(\{ canvasSelector: '#title-starfield'/, 'the title starfield ambient should be instantiated');
  assert.match(js, /const academyLoadingStarfield = createStarfieldAmbient\(\{ canvasSelector: '#academy-loading-starfield'/, 'the loading starfield ambient should be instantiated');

  // The image-rotation mechanism (element / frame / timer / helpers / keyframe) is removed without a trace.
  assert.doesNotMatch(html, /academy-loading-image|academy-loading-image-frame/, 'no loading image element/frame should remain');
  assert.doesNotMatch(js, /setAcademyLoadingImage|AcademyLoadingImageRotation|academyLoadingImageTimer|ACADEMY_LOADING_IMAGE_ROTATION/, 'no rotation helpers/state should remain');
  assert.doesNotMatch(css, /academy-loading-image-frame|academy-loading-image-in/, 'no loading image frame CSS / image-in keyframe should remain');
});

test('loading screen is a flat full-screen-direct meta surface (no window floating on the body gradient)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The layout collapses its padding/width for the loading interstitial exactly like the slot-load meta screen, so
  // the night art fills the layout edge-to-edge with no inset that would reveal the body's navy gradient as a border.
  assert.match(css, /body\.academy-loading-screen-active \.layout\s*\{[^}]*max-width:\s*none[^}]*padding:\s*0[^}]*\}/, 'the loading interstitial should drop the layout padding / max-width so the night ground reaches every edge (いきなり背景)');
  assert.match(css, /body\.academy-loading-screen-active\s*\{\s*overflow:\s*hidden;\s*\}/, 'the loading interstitial should lock body overflow like the other full-screen meta screens');
  // The active screen and its shell fill the screen; the shell is no longer a bordered/radiused/shadowed window.
  assert.match(css, /#academy-loading-screen\.active\s*\{[^}]*height:\s*100%[^}]*\}/, 'the active loading screen should fill the full-screen-direct layout');
  const loadingShellRule = css.match(/\.academy-loading-shell\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(loadingShellRule, /width:\s*100%/, 'the flat loading shell should fill the screen width');
  assert.doesNotMatch(loadingShellRule, /border:|border-radius:|box-shadow:|min\(1120px/, 'the flat loading shell drops the floating-window chrome (border / radius / shadow / width cap)');
});

test('loading screen traces a progress-driven constellation over its starfield, advanced only by observed events', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // A second full-bleed canvas over the ambient starfield in the same backdrop, and the module instantiated +
  // started/stopped by showScreen alongside the starfield.
  assert.match(html, /<canvas id="academy-loading-starfield"[^>]*><\/canvas>\s*<canvas id="academy-loading-constellation"[^>]*><\/canvas>/, 'the constellation canvas should layer over the starfield inside the loading backdrop');
  assert.match(css, /\.academy-loading-constellation\s*\{[\s\S]*position:\s*absolute[\s\S]*pointer-events:\s*none/, 'the constellation canvas should sit full-bleed and inert over the backdrop');
  assert.match(js, /import \{ createLoadingConstellation \} from '\.\/loadingConstellation\.js'/, 'app.js should import the constellation module');
  assert.match(js, /const academyLoadingConstellation = createLoadingConstellation\(\{ canvasSelector: '#academy-loading-constellation'/, 'the loading consumer should instantiate the constellation over its own canvas');
  // Continuous-loader line preservation: showScreen captures whether the loader was ALREADY active before its
  // class toggle, and only starts (resets) the constellation/starfield on a true non-loader → loader entry. A
  // loader → loader re-show (a back-to-back handoff such as achievement drain → hub return) leaves the constellation
  // running so its traced segments are not wiped back to zero.
  assert.match(js, /const loaderAlreadyActive = document\.body\.classList\.contains\('academy-loading-screen-active'\);/, 'showScreen should capture the prior loader-active state before toggling the loading class');
  assert.match(js, /if \(name === 'academy-loading' && !loaderAlreadyActive\) academyLoadingConstellation\.start\(\)/, 'showScreen should start (reset) the constellation only on a true non-loader → loader entry, not on a loader → loader re-show');
  assert.match(js, /if \(name === 'academy-loading' && !loaderAlreadyActive\) academyLoadingStarfield\.start\(\)/, 'showScreen should likewise preserve the loading starfield across a continuous loader handoff');
  assert.match(js, /if \(name !== 'academy-loading'\) academyLoadingConstellation\.stop\(\)/, 'showScreen should stop the constellation when leaving the loading screen');

  // The public progress notification is a no-op unless the loader is actually up (spec, not a silent fallback):
  // flows fire it at their event points regardless, and a call while the loader is hidden simply has nothing to advance.
  assert.match(js, /function notifyAcademyLoadingProgress\(\)\s*\{\s*if \(!document\.body\.classList\.contains\('academy-loading-screen-active'\)\) return;\s*academyLoadingConstellation\.notifyProgress\(\);\s*\}/, 'notifyAcademyLoadingProgress should advance the constellation only while the loader is showing');
  // assistant_delta is throttled (first delta + every Nth) so a long streamed opening does not exhaust the figure.
  assert.match(js, /function createLoadingProgressDeltaThrottle\(\)[\s\S]*count === 1 \|\| count % LOADING_PROGRESS_DELTA_STRIDE === 0/, 'a streamed delta should notify on the first delta and then only every stride-th delta');

  // Wired to the flows that carry observed events (SSE deltas/completes/drains/results + dungeon_enter + the
  // multi-await POST/refresh boundaries); single-JSON flows are not wired (no fabricated progress).
  const notifyCalls = js.match(/notifyAcademyLoadingProgress\(\)/g)?.length ?? 0;
  assert.ok(notifyCalls >= 23, `the observed-event points should be wired to the progress notification (found ${notifyCalls})`);
  assert.match(js, /if \(event === 'dungeon_enter'\) \{ bufferedView = data\.view; notifyAcademyLoadingProgress\(\); \}/, 'dungeon_enter should advance the constellation');

  // finalization_progress: the in-turn drain's block boundaries (memory / skill / work_record / state_effects /
  // commit) arrive on the already-open SSE. All three in-turn SSE readers advance the constellation on each,
  // so the loader raised during the post-turn drain keeps progressing. One handler per reader, anchored to the
  // reader's own drain signal so a reader losing the wiring fails here.
  const finalizationProgressHandlers = js.match(/if \(event === 'finalization_progress'\) notifyAcademyLoadingProgress\(\);/g)?.length ?? 0;
  assert.equal(finalizationProgressHandlers, 3, 'each of the three in-turn SSE readers wires finalization_progress to the progress notification');
  assert.match(js, /onRoutingDraining\?\.\(data\);[\s\S]{0,400}?if \(event === 'finalization_progress'\) notifyAcademyLoadingProgress\(\);/, 'the shared runAssistantSseStream reader advances the constellation on finalization_progress');
  assert.match(js, /beginGraduationSelectionPause\(\);[\s\S]{0,400}?if \(event === 'finalization_progress'\) notifyAcademyLoadingProgress\(\);/, 'the routing hub reader (runRoutingHubTurnStream) advances the constellation on finalization_progress');
  assert.match(js, /beginAchievementReadingPause\(data\.kind\);[\s\S]{0,400}?if \(event === 'finalization_progress'\) notifyAcademyLoadingProgress\(\);/, 'the daytime/achievement reader (runConversationDayTurnStream) advances the constellation on finalization_progress');

  // Each previously-0-edge site whose loader covers a real observed await boundary is now pinned to its wiring, so
  // removing any one of them fails this test (no reverting to the loose "≥N mentions" partial-wiring contract). The
  // site numbers are the loading-constellation-intermittent-investigation §2 census.
  // #21 / #26 — the generic in-turn routing destination and routing post-content arrival: the pre-arrival strict
  // field refresh inside showAcademyLoadingScreenUntilReady (only its refreshBeforeNextScreen callers reach it).
  assert.match(js, /await refresh\(\{ strictField: strictFieldRefresh \}\);[\s\S]{0,600}?notifyAcademyLoadingProgress\(\);/, '#21/#26: the pre-arrival field refresh boundary should advance the constellation');
  // #23 / #24 / #30 hub-start — every routing hub entry shares the hub-start POST and the following refresh.
  assert.match(js, /await postJson\('\/api\/routing\/hub\/start', \{\}\);[\s\S]{0,600}?notifyAcademyLoadingProgress\(\);/, '#23/#24/#30: the routing hub-start POST boundary should advance the constellation');
  assert.match(js, /await refresh\(\);\s*notifyAcademyLoadingProgress\(\);\s*showScreen\('routing-hub'\);/, '#23/#24/#30: the routing hub refresh boundary should advance the constellation before the hub shows');
  // #9 — the in-session stage move: the destination-stage refresh inside the readiness closure.
  assert.match(js, /readiness: \(async \(\) => \{ await refresh\(\); notifyAcademyLoadingProgress\(\); \}\)\(\),\s*nextScreen: 'academy-conversation-session'/, '#9: the in-session stage-move refresh boundary should advance the constellation');
  // #7 — the loop training completion: the readiness wait and the pending-event scan (no-event map landing).
  assert.match(js, /notifyAcademyLoadingProgress\(\);\s*const status = await refreshEventFlagStatus\(\);\s*notifyAcademyLoadingProgress\(\);/, '#7: the loop completion readiness + event-scan boundaries should advance the constellation');
  // #22 graduation branch — the graduation ending end keeps the loader up on its finalization; the non-graduation
  // single-JSON end stays unwired (guarded on endingConversation).
  assert.match(js, /if \(endingConversation\) notifyAcademyLoadingProgress\(\);/, '#22: the graduation ending end boundaries should advance the constellation (guarded so the single-JSON manual end stays unwired)');
  // #30 — the dungeon exit companion finalize drain held under the exit loading screen.
  assert.match(js, /await activeDungeonFinalizationPromise; notifyAcademyLoadingProgress\(\);/, '#30: the dungeon-exit companion finalize boundary should advance the constellation');
  // #31 consignment picker branch — the enter POST (past the closed branch) and the consignment options GET.
  assert.match(js, /await postJson\('\/api\/auction\/enter', \{\}\);[\s\S]{0,800}?notifyAcademyLoadingProgress\(\);/, '#31: the auction enter boundary should advance the constellation for a non-closed visit');
  assert.match(js, /const options = await getJson\('\/api\/auction\/consignment\/options'\);[\s\S]{0,500}?notifyAcademyLoadingProgress\(\);/, '#31: the consignment options GET boundary should advance the picker constellation');
  // The closed auction branch returns before the enter-boundary notify, so it is deliberately left unwired.
  assert.match(js, /if \(view\.status === 'closed'\) \{ auctionPhase = 'closed';[^\n]*renderAuctionClosed\(view\); return; \}/, '#31 closed branch stays unwired: it returns before the enter-boundary notify');
  // No text-progress line / percentage readout was introduced on the loading copy (title/status stay the existing
  // two lines; the constellation carries progress purely as drawn segments).
  assert.doesNotMatch(js, /academy-loading-status[^\n]*%|setAcademyLoadingProgressText|academy-loading-progress/i, 'no textual progress / percentage readout should be added to the loading copy');
});

test('slot-load screen joins the metaphysical-moonlight meta layer: full-screen night ground, memory cards, night action buttons, starfield ambient, no shell window', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const slotBlock = html.match(/<section id="slot-load-screen"[\s\S]*?<section id="world-screen"/)?.[0] ?? '';
  assert.notEqual(slotBlock, '', 'slot-load screen block should be locatable');

  // Full-screen night ground: a backdrop (night art + scrim div + starfield canvas) with the content laid
  // directly on top. The old shell window (a big bordered card wrapping the slots) is gone from markup.
  assert.match(slotBlock, /<div class="slot-load-backdrop"[^>]*>[\s\S]*<div class="slot-load-background">[\s\S]*<canvas id="slot-load-starfield" class="slot-load-starfield">[\s\S]*<\/div>/, 'slot-load should host a backdrop with the night background + its own starfield canvas');
  assert.match(slotBlock, /<div class="slot-load-content">[\s\S]*class="screen-heading slot-load-screen-heading"[\s\S]*<div class="slot-load-board"/, 'slot-load content should carry the heading + the slot board directly (no shell window wrapper)');
  assert.doesNotMatch(slotBlock, /slot-load-shell|slot-load-card|app-card/, 'the shell window / app-card wrapper should be removed from the slot-load markup without a trace');
  // The metaphysical-moonlight restyle drops the English eyebrows across the whole slot-load screen (silver
  // heading only) — the content heading + board AND the delete-confirm dialog, which now joins the meta layer.
  assert.doesNotMatch(slotBlock, /class="eyebrow"/, 'the metaphysical-moonlight slot-load screen (heading, board, and the delete-confirm dialog) drops the English eyebrows — silver heading only');

  // Mechanics-invariant DOM hooks survive the restyle: heading, list container, resume/back buttons, and the
  // delete-confirm dialog (openLoadScreen / GET /api/slots enumeration / load / resume all key off these).
  for (const hook of ['slot-load-title', 'slot-load-list-title', 'slot-load-list', 'slot-load-resume-play', 'back-to-title-screen', 'slot-load-delete-confirm-dialog']) {
    assert.match(slotBlock, new RegExp(`id="${hook}"`), `slot-load restyle must preserve the #${hook} hook`);
  }

  // Token layer: #slot-load-screen shares the meta scope and defines its own slot scrim + glow (var(--meta-*)
  // only — no literal color pin). The background div consumes those tokens over the night art.
  assert.match(css, /#settings-screen,\n#debug-screen,\n#world-screen,\n#field-screen,\n.topbar \{[\s\S]*?--meta-slot-scrim:[\s\S]*?--meta-slot-glow:[\s\S]*?--meta-settings-scrim:[\s\S]*?--meta-settings-glow:/, 'the shared meta token block (ending on the .topbar selector) should define the slot-select and settings scrim + glow gradients');
  const slotBgCss = cssRuleBlock(css, '.slot-load-background');
  assert.match(slotBgCss, /background:[\s\S]*var\(--meta-slot-glow\),[\s\S]*var\(--meta-slot-scrim\),[\s\S]*url\('\/canonical\/load\/slot_select_night\.jpg'\)/, 'slot-load background should layer the tokenized glow + scrim over the canonical slot-select night art');
  const slotActiveCss = cssRuleBlock(css, '#slot-load-screen.active');
  assert.match(slotActiveCss, /position:\s*relative[\s\S]*isolation:\s*isolate[\s\S]*overflow:\s*hidden/, 'active slot-load screen should establish its own stacking context that clips the full-bleed backdrop');
  assert.match(css, /\.slot-load-starfield\s*\{[\s\S]*position:\s*absolute[\s\S]*pointer-events:\s*none/, 'the slot-load starfield canvas should sit behind the content full-bleed');

  // Memory cards: each slot is a deep-night silver panel with a starlight hairline; hover / focus-within flares
  // a starlight glow. The old warm-gold divider between rows is gone (destructive restyle, token-only).
  const slotItemCss = cssRuleBlock(css, '.slot-load-item');
  assert.match(slotItemCss, /border:\s*1px solid var\(--meta-line\)/, 'slot card: silver hairline border (token)');
  assert.match(slotItemCss, /border-radius:\s*var\(--radius-card\)/, 'slot card: shared card radius');
  assert.match(slotItemCss, /background:\s*var\(--meta-panel\)/, 'slot card: deep-night moonlight panel');
  assert.match(slotItemCss, /box-shadow:\s*0 0 0 1px var\(--meta-line\), 0 12px 30px var\(--meta-shadow\)/, 'slot card: moonlight resting shadow (token-only)');
  assert.doesNotMatch(slotItemCss, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'slot card chrome must be token-only (no literal color pin)');
  assert.match(css, /\.slot-load-item:hover,\n\.slot-load-item:focus-within \{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*box-shadow:[\s\S]*var\(--meta-glow\)/, 'slot card should flare a starlight border + glow on hover / focus-within');
  assert.doesNotMatch(css, /\.slot-load-item \+ \.slot-load-item \{[\s\S]*border-top/, 'the legacy gold row-divider between slots should be removed without a trace');

  // Empty state: a quiet sunken-silver panel when there is no save data.
  const slotEmptyCss = cssRuleBlock(css, '.slot-load-list .continuity-empty');
  assert.match(slotEmptyCss, /background:\s*var\(--meta-panel\)[\s\S]*color:\s*var\(--meta-silver-dim\)/, 'the empty slot-load state should read as a sunken-silver quiet panel');

  // Action buttons: the shared academy button keeps its layout while the slot-load CONTENT scope recolors the
  // chrome to moonlight silver with a starlight hover/focus-visible flare. Scoped to .slot-load-content so the
  // shared delete-confirm dialog buttons keep their own chrome.
  const slotActionCss = cssRuleBlock(css, '#slot-load-screen .slot-load-content .academy-map-action-button');
  assert.match(slotActionCss, /border:\s*1px solid var\(--meta-line-strong\)[\s\S]*background:\s*var\(--meta-panel\)[\s\S]*color:\s*var\(--meta-silver-strong\)/, 'slot-load actions should adopt the moonlight silver filigree chrome');
  assert.match(css, /#slot-load-screen \.slot-load-content \.academy-map-action-button:hover:not\(:disabled\),\n#slot-load-screen \.slot-load-content \.academy-map-action-button:focus-visible \{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*box-shadow:\s*0 0 14px var\(--meta-glow\)/, 'slot-load actions should flare a starlight border + glow on hover and focus-visible');

  // Ambient: the slot-load consumer instantiates the SHARED starfield part (same reduced-motion static-draw +
  // canvas.dataset.starfield contract as the title / loading / hub), started on show and stopped on leave. The
  // reduced-motion behavior is owned by createStarfieldAmbient (covered by its own tests), so reusing the part
  // is the source-level guarantee that drift is disabled under prefers-reduced-motion.
  assert.match(js, /const slotLoadStarfield = createStarfieldAmbient\(\{ canvasSelector: '#slot-load-starfield', starColorRgb: '207, 218, 255'/, 'the slot-load consumer should instantiate the shared starfield ambient over its own canvas');
  assert.match(js, /if \(name === 'slot-load'\) slotLoadStarfield\.start\(\)/, 'showScreen should start the slot-load starfield when the screen opens');
  assert.match(js, /if \(name !== 'slot-load'\) slotLoadStarfield\.stop\(\)/, 'showScreen should stop the slot-load starfield when leaving the screen');
  assert.match(js, /document\.body\.classList\.toggle\('slot-load-screen-active',\s*name === 'slot-load'\)/, 'showScreen should keep the slot-load-active body class in sync');
});

test('slot-load delete-confirm dialog joins the metaphysical-moonlight meta layer: deep-night silver panel + starlight buttons, no old gold shell chrome', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const slotBlock = html.match(/<section id="slot-load-screen"[\s\S]*?<section id="world-screen"/)?.[0] ?? '';
  const dialogMarkup = slotBlock.match(/<dialog id="slot-load-delete-confirm-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.notEqual(dialogMarkup, '', 'delete-confirm dialog markup should be locatable');

  // The dialog is a DOM child of #slot-load-screen, so it inherits the --meta-* tokens even in the showModal()
  // top layer. It keeps the shared dialog/card LAYOUT classes (recolored in an id scope) plus the mechanics
  // hooks (title, submit, cancel), while the meta heading-only vocabulary drops the English eyebrow and the old
  // warm-gold surface / title-row wrappers are removed without a trace.
  assert.match(dialogMarkup, /class="interaction-detail-dialog[^"]*"/, 'dialog keeps the shared dialog layout class for id-scoped recolor');
  assert.match(dialogMarkup, /<form method="dialog" class="interaction-detail-card">/, 'dialog form keeps only the shared card padding class (old gold surface wrapper removed)');
  assert.doesNotMatch(dialogMarkup, /class="eyebrow"|academy-map-location-card|panel-title-row/, 'the meta restyle drops the English eyebrow and the old gold surface / title-row wrappers without a trace');
  for (const hook of ['slot-load-delete-confirm-title', 'slot-load-delete-confirm-submit', 'slot-load-delete-confirm-cancel']) {
    assert.match(dialogMarkup, new RegExp(`id="${hook}"`), `delete dialog must preserve the #${hook} mechanics hook`);
  }

  // Panel: deep-night moonlight surface + starlight hairline + moonlight drop shadow, token-only (no gold/cream).
  const dialogCss = cssRuleBlock(css, '#slot-load-delete-confirm-dialog');
  assert.match(dialogCss, /border:\s*1px solid var\(--meta-line-strong\)/, 'delete dialog panel: starlight hairline (token)');
  assert.match(dialogCss, /background:\s*var\(--meta-panel-strong\)/, 'delete dialog panel: deep-night moonlight surface');
  assert.match(dialogCss, /box-shadow:\s*0 24px 60px var\(--meta-shadow\)/, 'delete dialog panel: moonlight drop shadow (token-only)');
  assert.doesNotMatch(dialogCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'delete dialog panel chrome must be token-only (no literal gold/cream color pin)');

  // Backdrop dims to a deep-night moonlight scrim (token), not the old flat black rgba.
  assert.match(css, /#slot-load-delete-confirm-dialog::backdrop \{[\s\S]*background:\s*var\(--meta-shadow\)/, 'delete dialog backdrop should dim to a deep-night moonlight scrim token');

  // Heading + body read as moonlight silver.
  assert.match(css, /#slot-load-delete-confirm-dialog #slot-load-delete-confirm-title \{[\s\S]*color:\s*var\(--meta-silver-strong\)/, 'delete dialog title should read as bright moonlight silver');
  assert.match(css, /#slot-load-delete-confirm-dialog \.interaction-detail-text \{[\s\S]*color:\s*var\(--meta-silver\)/, 'delete dialog body text should read as moonlight silver');

  // Buttons: the shared academy button keeps its layout while the dialog scope recolors the chrome to the
  // moonlight silver frame; primary (削除する) holds emphasis with a starlight frame + bright fill, secondary
  // (削除しない) drops to a quiet silver line. All states are token-only (no gold hover).
  const btnBase = cssRuleBlock(css, '#slot-load-delete-confirm-dialog .academy-map-action-button');
  assert.match(btnBase, /border:\s*1px solid var\(--meta-line-strong\)[\s\S]*background:\s*var\(--meta-panel\)[\s\S]*color:\s*var\(--meta-silver-strong\)/, 'delete dialog buttons adopt the moonlight silver filigree chrome');
  assert.doesNotMatch(btnBase, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'delete dialog button chrome must be token-only (no literal color pin)');
  assert.match(css, /#slot-load-delete-confirm-dialog \.academy-map-action-button\.primary \{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*background:\s*var\(--meta-night-2\)[\s\S]*color:\s*var\(--meta-silver-strong\)/, 'delete (primary) button holds emphasis with a starlight frame + bright moonlight fill');
  assert.match(css, /#slot-load-delete-confirm-dialog \.academy-map-action-button\.secondary \{[\s\S]*border-color:\s*var\(--meta-line\)[\s\S]*color:\s*var\(--meta-silver\)/, 'cancel (secondary) button drops to a quiet moonlight silver line');
  assert.match(css, /#slot-load-delete-confirm-dialog \.academy-map-action-button:hover:not\(:disabled\) \{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*box-shadow:\s*0 0 18px var\(--meta-glow\)/, 'delete dialog buttons flare a starlight border + glow on hover');
});

test('settings screen joins the metaphysical-moonlight meta layer (full-screen night ground, moonlight panels + nav, starfield ambient, no shell window) while staying a first-class route with the title 設定 control', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  assert.match(html, /data-screen="academy-room"[\s\S]*>自室<[\s\S]*data-screen="slot-load"[^>]*>ロード<[\s\S]*data-screen="settings"[^>]*>設定</, 'topbar should expose 設定 after ロード as another right-side runtime route');
  assert.match(html, /<section id="title-screen"[\s\S]*class="title-action-layout"[\s\S]*class="title-primary-actions"[\s\S]*id="start-new-game"[\s\S]*最初から始める[\s\S]*id="open-load-screen"[\s\S]*ロード[\s\S]*class="title-settings-action"[\s\S]*id="open-settings-screen"[\s\S]*設定/, 'title screen should split primary actions from a dedicated right-side settings action within the title panel');
  // 形而上の月夜化: the shell window / app-card wrapper is gone — the hero + master-detail body sit directly on a
  // full-screen night ground (.settings-content). The LM Studio panel keeps its connection fields, model
  // selection, and model-fetch action.
  assert.match(html, /<section id="settings-screen" class="screen" aria-labelledby="settings-title">[\s\S]*<div class="settings-content">[\s\S]*<p class="eyebrow">Settings<\/p>[\s\S]*<h2 id="settings-title">設定<\/h2>[\s\S]*class="settings-screen-hero-actions"[\s\S]*id="settings-back-to-title"[^>]*class="academy-map-action-button secondary"[\s\S]*id="lmstudio-settings-form"[\s\S]*id="lmstudio-connection-mode-localhost"[\s\S]*id="lmstudio-connection-mode-lan"[\s\S]*id="lmstudio-host"[\s\S]*id="lmstudio-port"[\s\S]*id="fetch-lmstudio-models"[\s\S]*id="lmstudio-model"[\s\S]*id="lmstudio-thinking-effort"/, 'settings screen should drop the shell window for the moonlight content ground while keeping the hero and LM Studio connection fields, model selection, and model fetch action');
  // Symmetric on-change apply: the LM Studio panel has NO explicit save button, and the separate
  // return-to-title button that lived in the old save action row is gone (the hero button covers it).
  assert.doesNotMatch(html, /id="save-lmstudio-settings"/, 'the LM Studio save button should be removed — connection settings apply on change like the cooldown preset');
  assert.doesNotMatch(html, /id="settings-form-back-to-title"/, 'the LM Studio save action row (and its duplicate return-to-title button) should be removed');

  const settingsScreenHtml = html.match(/<section id="settings-screen"[\s\S]*?<\/section>\s*<section id="academy-map-screen"/)?.[0] ?? '';
  assert.notEqual(settingsScreenHtml, '', 'settings screen block should be locatable');
  // Full-screen night ground: a backdrop (night art + scrim div + its own starfield canvas) with the hero +
  // body laid directly over it — no shell window / app-card wrapper anywhere in the markup.
  assert.match(settingsScreenHtml, /<div class="settings-backdrop"[^>]*>[\s\S]*<div class="settings-background"><\/div>[\s\S]*<canvas id="settings-starfield" class="settings-starfield"><\/canvas>[\s\S]*<\/div>/, 'settings should host a backdrop with the night background + its own starfield canvas');
  assert.doesNotMatch(settingsScreenHtml, /academy-map-shell|settings-screen-shell|app-card/, 'the shell window / app-card wrapper should be removed from the settings markup without a trace');
  // The hero drops the standalone how-to-use sentence; the freed height goes to the settings-item body below.
  assert.doesNotMatch(settingsScreenHtml, /左のカテゴリを選ぶと|保存ボタンはありません/, 'the settings hero how-to-use explanation sentence should be removed without a trace');
  assert.match(settingsScreenHtml, /<div class="settings-screen-hero-copy">\s*<p class="eyebrow">Settings<\/p>\s*<h2 id="settings-title">設定<\/h2>\s*<\/div>/, 'the hero copy should keep only the eyebrow and title after dropping the explanation paragraph');
  // Master-detail: the content ground carries the hero then a body whose first child is a category nav (LM
  // Studio / conversation popup / 会話後処理) followed by a panels wrapper. Every section is a
  // .settings-category-panel; only the selected category's panel is shown, so a stacked card can never collapse another.
  assert.match(settingsScreenHtml, /<div class="settings-content">\s*<div class="academy-map-hero settings-screen-hero">[\s\S]*<\/div>\s*<div class="settings-screen-body">\s*<nav class="settings-category-nav" aria-label="設定カテゴリ">[\s\S]*data-settings-category="lmstudio" aria-controls="settings-panel-lmstudio"[\s\S]*data-settings-category="conversation-popup" aria-controls="settings-panel-conversation-popup"[\s\S]*data-settings-category="conversation-finalize" aria-controls="settings-panel-conversation-finalize"[\s\S]*<\/nav>\s*<div class="settings-category-panels">/, 'the content ground should carry the hero then a body whose first child is the category nav listing the three categories, then the panels wrapper');
  // Default category = LM Studio: its nav tab is pre-marked active, its panel is the one NOT carrying
  // the hidden attribute, and the other two panels start hidden (no empty panel on open).
  assert.match(settingsScreenHtml, /class="settings-category-tab is-active" data-settings-category="lmstudio" aria-controls="settings-panel-lmstudio" aria-pressed="true"/, 'the LM Studio category tab should be the pre-selected active tab');
  assert.match(settingsScreenHtml, /<section id="settings-panel-lmstudio" class="settings-card settings-category-panel" data-settings-category="lmstudio" aria-labelledby="lmstudio-settings-title">/, 'the LM Studio panel should be the default-visible panel (no hidden attribute)');
  assert.match(settingsScreenHtml, /<section id="settings-panel-conversation-popup" class="settings-card settings-category-panel" data-settings-category="conversation-popup" aria-labelledby="conv-popup-settings-title" hidden>/, 'the conversation-popup panel should start hidden');
  assert.match(settingsScreenHtml, /<section id="settings-panel-conversation-finalize" class="settings-card settings-category-panel" data-settings-category="conversation-finalize" aria-labelledby="conversation-finalize-settings-title" hidden>/, 'the 会話後処理 panel should start hidden');
  assert.doesNotMatch(settingsScreenHtml, /settings-panel-play-mode|data-settings-category="play-mode"/, 'the loop/routing play-mode settings panel is removed');

  assert.match(js, /const screens = \{[\s\S]*settings: document\.querySelector\('#settings-screen'\)/, 'browser screen registry should add the settings screen');
  assert.match(js, /async function loadLmStudioSettings\(\)/, 'front-end should expose a dedicated LM Studio settings loader');
  assert.match(js, /async function fetchLmStudioModels\(\)/, 'front-end should expose a dedicated LM Studio model discovery action');
  assert.match(js, /async function saveLmStudioSettings\(\)/, 'front-end should expose a dedicated LM Studio settings saver');
  assert.match(js, /getJson\('\/api\/settings\/lmstudio'\)/, 'settings screen should fetch the current LM Studio settings from the server');
  assert.match(js, /fetch\('\/api\/settings\/lmstudio\/models', \{[\s\S]*method: 'POST'/, 'settings screen should request model options through the runtime server instead of calling LM Studio directly from the browser');
  assert.match(js, /patchJson\('\/api\/settings\/lmstudio', \{[\s\S]*connection_mode: connectionMode,[\s\S]*host: host\?\.value,[\s\S]*port: Number\(port\?\.value \|\| 1234\),[\s\S]*model: selectedModel/, 'settings apply action should PATCH LM Studio settings through the shared patchJson (so a non-OK response carries the server error body) with the selected model alongside the connection fields');
  // The apply action requires a model; when none is chosen it surfaces the requirement and declines
  // to PATCH (a visible prompt — not a silent skip).
  assert.match(js, /async function saveLmStudioSettings\(\)\s*\{[\s\S]*const selectedModel = normalizeLmStudioModelValue\(model\?\.value\);\s*if \(!selectedModel\) \{[\s\S]*return null;\s*\}/, 'saveLmStudioSettings should gate on a chosen model and surface the requirement instead of PATCHing an incomplete config');
  // A failed save must drive the category status to a terminal error (concrete reason) instead of leaving
  // it stuck on 反映中です, then rethrow to reportError so console/global reporting is unchanged. The
  // settingsSaveErrorMessage helper is shared with settingsSaveError.test.mjs (the three failure modes are
  // covered there); here we guard that each save action wires it in its catch and rethrows.
  assert.match(js, /import \{ settingsSaveErrorMessage \} from '\.\/settingsSaveError\.js'/, 'app.js should import the shared settings-save error surfacing helper');
  assert.match(js, /async function saveLmStudioSettings\(\)\s*\{[\s\S]*?setLmStudioSettingsStatus\('反映中です。'\);[\s\S]*?try \{[\s\S]*?patchJson\('\/api\/settings\/lmstudio'[\s\S]*?\} catch \(error\) \{\s*setLmStudioSettingsStatus\(settingsSaveErrorMessage\(error, 'LM Studio'\)\);\s*throw error;\s*\}/, 'saveLmStudioSettings should surface a failure as a terminal category error and rethrow to reportError');
  // Master-detail category nav: a fail-fast selector shows exactly one panel, and every settings
  // entry opens on the default category so no empty panel is shown.
  assert.match(js, /const SETTINGS_CATEGORIES = \['lmstudio', 'conversation-popup', 'conversation-finalize', 'audio'\]/, 'front-end should declare the settings categories including the audio (サウンド) category');
  assert.match(js, /const DEFAULT_SETTINGS_CATEGORY = 'lmstudio'/, 'LM Studio should be the default settings category');
  assert.match(js, /function selectSettingsCategory\(category\)\s*\{[\s\S]*if \(!SETTINGS_CATEGORIES\.includes\(category\)\) \{[\s\S]*throw new Error\(`unknown settings category: \$\{category\}`\)[\s\S]*panel\.hidden = panel\.dataset\.settingsCategory !== category[\s\S]*\}/, 'selectSettingsCategory should fail-fast on an unknown category and toggle panels by the hidden attribute');
  assert.match(js, /function openSettingsScreen\(\)\s*\{[\s\S]*selectSettingsCategory\(DEFAULT_SETTINGS_CATEGORY\)/, 'opening the settings screen should select the default category so no empty panel is shown');
  assert.match(js, /for \(const tab of document\.querySelectorAll\('\.settings-category-tab'\)\) \{\s*tab\.addEventListener\('click', \(\) => selectSettingsCategory\(tab\.dataset\.settingsCategory\)\)/, 'each category tab should switch to its category on click');
  assert.match(js, /document\.body\.classList\.toggle\('settings-screen-active',\s*name === 'settings'\)/, 'showScreen should keep a dedicated settings-active body class in sync so the topbar can hide on the settings route');
  assert.match(js, /document\.body\.classList\.toggle\('academy-loading-screen-active',\s*name === 'academy-loading'\)/, 'showScreen should keep an academy-loading-active body class in sync so the topbar stays hidden through the loading interstitial (e.g. the routing wrap-up return to title never flashes the topbar)');
  assert.match(js, /#open-load-screen[\s\S]*openLoadScreen\(\{ canResumePlay: false \}\)/, 'title load button should open the load screen with play-resume disabled');
  assert.match(js, /querySelector\('#open-settings-screen'\)\s*\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*openSettingsScreen\(\);\s*\}\)/, 'title settings button should route into the shared settings screen via openSettingsScreen()');
  assert.match(js, /#settings-back-to-title[\s\S]*showScreen\('title'\)/, 'settings heading should provide a direct return-to-title button');
  assert.match(js, /if \(tab\.dataset\.screen === 'settings'\) \{\s*openSettingsScreen\(\);\s*return;\s*\}/, 'topbar settings route should open the shared settings screen via openSettingsScreen()');
  // LM Studio settings apply on change, not on a save button: committed host/port edits, connection
  // mode toggles, and model / thinking-effort selections each drive saveLmStudioSettings.
  // The window is bounded ({0,120}) so an unrelated 'submit' listener elsewhere in app.js (e.g. the library
  // search form) does not span forward to a distant saveLmStudioSettings and false-positive; a real LM Studio
  // submit→save regression calls it within a handler body, well inside this window (ref-ui-tokens: greedy
  // unbounded negative snapshots misfire on new screens; the on-change positive asserts below carry the intent).
  assert.doesNotMatch(js, /addEventListener\('submit'[\s\S]{0,120}saveLmStudioSettings/, 'the LM Studio form should no longer save on submit — there is no save button');
  assert.match(js, /for \(const input of \[document\.querySelector\('#lmstudio-host'\), document\.querySelector\('#lmstudio-port'\)\]\) \{[\s\S]*input\.addEventListener\('change', \(\) => saveLmStudioSettings\(\)\.catch\(reportError\)\)[\s\S]*input\.addEventListener\('keydown'[\s\S]*input\.blur\(\)/, 'host/port edits should apply on change (blur/Enter) with no save button');
  assert.match(js, /for \(const radio of \[document\.querySelector\('#lmstudio-connection-mode-localhost'\), document\.querySelector\('#lmstudio-connection-mode-lan'\)\]\) \{\s*radio\.addEventListener\('change', \(\) => \{\s*syncLmStudioConnectionModeUi\(\);\s*saveLmStudioSettings\(\)\.catch\(reportError\)/, 'connection mode toggles should apply on change');
  assert.match(js, /document\.querySelector\('#lmstudio-model'\)\.addEventListener\('change', \(\) => saveLmStudioSettings\(\)\.catch\(reportError\)\)/, 'model selection should apply on change');
  assert.match(js, /document\.querySelector\('#lmstudio-thinking-effort'\)\.addEventListener\('change', \(\) => saveLmStudioSettings\(\)\.catch\(reportError\)\)/, 'thinking-effort selection should apply on change');
  assert.match(js, /function openSettingsScreen\(\)\s*\{[\s\S]*?loadLmStudioSettings\(\)\.catch\(reportError\)[\s\S]*?loadConversationPopupSettings\(\)\.catch\(reportError\)[\s\S]*?renderRoutingFinalizePanel\(\);[\s\S]*?\n\}/, 'opening the settings screen should load LM Studio + conversation popup settings and render the finalize panel regardless of entry');
  assert.match(js, /#fetch-lmstudio-models[\s\S]*fetchLmStudioModels\(\)\.catch\(reportError\)/, 'settings screen should wire the fetch-models button to the shared model discovery action');
  // Ambient: the shared conversation-stage starfield part, started on the settings screen and stopped on leave.
  assert.match(js, /const settingsStarfield = createStarfieldAmbient\(\{ canvasSelector: '#settings-starfield'/, 'the settings consumer should instantiate the shared starfield ambient over its own canvas');
  assert.match(js, /if \(name === 'settings'\) settingsStarfield\.start\(\)/, 'showScreen should start the settings starfield when the settings screen opens');
  assert.match(js, /if \(name !== 'settings'\) settingsStarfield\.stop\(\)/, 'showScreen should stop the settings starfield when leaving the settings screen');

  assert.match(css, /#title-screen\.active\s*\{[\s\S]*place-items:\s*end center;/, 'active title screen should anchor the panel to the bottom-center in the winning rule');
  const titleShellCss = cssRuleBlock(css, '.title-screen-shell');
  assert.match(titleShellCss, /margin:\s*0 0 clamp\(18px, 3\.4vw, 42px\) 0[\s\S]*padding:\s*clamp\(11px, 1\.75vw, 17px\)[\s\S]*border-radius:\s*var\(--radius-frame\)/, 'title shell should keep the existing shell dimensions (now bottom-center) while joining the bigframe radius');
  assert.match(css, /\.title-screen-shell h2\s*\{[\s\S]*font-size:\s*clamp\(21px, 3\.05vw, 42px\)[\s\S]*color:\s*var\(--meta-silver-strong\)[\s\S]*text-shadow:\s*var\(--shadow-title-heading\)/, 'title heading should keep the current retuned real font size while consuming the moonlight silver + shared shadow tokens');
  const titleActionLayoutCss = cssRuleBlock(css, '.title-action-layout');
  assert.notEqual(titleActionLayoutCss, '', 'the .title-action-layout rule should exist');
  assert.match(titleActionLayoutCss, /display:\s*flex[\s\S]*align-items:\s*center[\s\S]*gap:\s*10px[\s\S]*margin:\s*14px 0 0/, 'title action layout should provide a shared row for left actions and the right-side settings action');
  assert.match(css, /\.title-primary-actions\s*\{[\s\S]*display:\s*flex[\s\S]*gap:\s*10px[\s\S]*flex-wrap:\s*wrap/, 'title primary actions should keep the left-side button group compact');
  assert.match(css, /\.title-settings-action\s*\{[\s\S]*margin-left:\s*auto[\s\S]*display:\s*flex[\s\S]*justify-content:\s*flex-end/, 'title settings action wrapper should push the settings button to the right edge of the panel');
  assert.match(css, /\.title-screen-shell \.title-action-button\s*\{[\s\S]*min-width:\s*124px[\s\S]*font-size:\s*14px/, 'title action buttons should preserve the current direct-dimension sizing');
  assert.doesNotMatch(titleShellCss, /transform:\s*scale\(/, 'title-shell shrink should not be implemented via transform scaling');
  assert.match(css, /body\.settings-screen-active\s+\.topbar\s*{\s*display:\s*none;\s*}/, 'settings screen should hide the topbar the same way the title and slot-load routes do');
  assert.match(css, /body\.academy-loading-screen-active\s+\.topbar\s*{\s*display:\s*none;\s*}/, 'the academy-loading interstitial should hide the topbar the same way the other meta screens do, so no topbar flashes between screens');
  assert.match(css, /body\.settings-screen-active\s*\{\s*overflow:\s*hidden;\s*}/, 'settings screen should lock body overflow so only the settings content card scrolls');
  assert.match(css, /body:has\(#settings-screen\.active\) \.layout\s*\{[\s\S]*height:\s*100dvh[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'settings route hides the topbar, so its layout should fill the viewport and delegate overflow to the settings card');
  assert.match(css, /#settings-screen\.active\s*\{[\s\S]*display:\s*grid[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'active settings screen should stay inside the bounded layout instead of scrolling the page');
  // The non-selected category panels and the failed-finalization panel are toggled via the `hidden`
  // attribute, but .settings-card / .routing-finalize-panel set display:grid, which would override the UA
  // [hidden] rule. This id-scoped guard keeps any hidden settings element actually hidden — so only the
  // selected category's panel shows, and the finalize panel shows only when there are failed jobs.
  assert.match(css, /#settings-screen \[hidden\]\s*\{\s*display:\s*none;\s*\}/, 'settings screen should guard hidden elements so non-selected category panels (display:grid .settings-card) and the finalize panel are actually hidden');
  // Full-bleed night ground: the active screen establishes its own stacking context that clips the backdrop,
  // and the content layer owns the hero/body row split the shell used to hold (no shell/bigframe rule anymore).
  const settingsActiveCss = cssRuleBlock(css, '#settings-screen.active');
  assert.match(settingsActiveCss, /position:\s*relative[\s\S]*isolation:\s*isolate[\s\S]*display:\s*grid[\s\S]*overflow:\s*hidden/, 'active settings screen should establish its own stacking context that clips the full-bleed backdrop');
  const settingsBackdropCss = cssRuleBlock(css, '.settings-backdrop');
  assert.match(settingsBackdropCss, /position:\s*absolute[\s\S]*inset:\s*0[\s\S]*pointer-events:\s*none/, 'the backdrop should be a full-bleed non-interactive layer behind the content');
  const settingsBackgroundCss = cssRuleBlock(css, '.settings-background');
  assert.match(settingsBackgroundCss, /background:[\s\S]*var\(--meta-settings-glow\),[\s\S]*var\(--meta-settings-scrim\),[\s\S]*url\('\/canonical\/settings\/settings_night\.jpg'\)/, 'settings background should layer the tokenized glow + scrim over the canonical settings night art');
  assert.match(css, /\.settings-starfield\s*\{[\s\S]*position:\s*absolute[\s\S]*pointer-events:\s*none/, 'the settings starfield canvas should sit behind the content full-bleed');
  const settingsContentCss = cssRuleBlock(css, '.settings-content');
  assert.match(settingsContentCss, /position:\s*relative[\s\S]*z-index:\s*1[\s\S]*display:\s*grid[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'the content ground should sit above the backdrop and split the hero (auto) + body (1fr) rows the shell used to hold');
  // Master-detail: the body is a two-column grid (a fixed category-nav column + the detail column).
  // The nav column and the panels column each own their own scroll; only the selected panel shows, so
  // the previous "stacked cards collapse each other" failure mode cannot recur.
  const settingsScreenBodyCss = cssRuleBlock(css, '.settings-screen-body');
  assert.match(settingsScreenBodyCss, /min-height:\s*0[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*minmax\(180px, 220px\) minmax\(0, 1fr\)[\s\S]*gap:\s*16px[\s\S]*overflow:\s*hidden/, 'the settings body should be a fixed-nav + detail two-column master-detail grid');
  const settingsCategoryNavCss = cssRuleBlock(css, '.settings-category-nav');
  assert.match(settingsCategoryNavCss, /min-height:\s*0[\s\S]*display:\s*grid[\s\S]*align-content:\s*start[\s\S]*overflow-y:\s*auto/, 'the category nav should be a scrollable top-aligned list column');
  // Moonlight chrome (test-by-token, var(--meta-*) only): silver-hairline tabs with a starlight-flare active
  // tab, deep-night silver panels, moonlight silver status text, silver-hairline radio/model panels.
  const settingsCategoryTabCss = cssRuleBlock(css, '.settings-category-tab');
  assert.match(settingsCategoryTabCss, /text-align:\s*left[\s\S]*border:\s*1px solid var\(--meta-line\)[\s\S]*border-radius:\s*var\(--radius-panel-compact\)[\s\S]*background:\s*var\(--meta-panel\)[\s\S]*cursor:\s*pointer/, 'a category tab should be a left-aligned deep-night silver-hairline button (token-only)');
  assert.match(css, /\.settings-category-tab\.is-active\s*\{[\s\S]*border-color:\s*var\(--meta-starlight\)[\s\S]*background:\s*var\(--meta-panel-strong\)[\s\S]*box-shadow:\s*0 0 14px var\(--meta-glow\)/, 'the active category tab should flare a starlight border + moonlight glow');
  const settingsCategoryPanelsCss = cssRuleBlock(css, '.settings-category-panels');
  assert.match(settingsCategoryPanelsCss, /min-height:\s*0[\s\S]*display:\s*grid[\s\S]*align-content:\s*start[\s\S]*overflow-y:\s*auto[\s\S]*overflow-x:\s*hidden[\s\S]*scrollbar-gutter:\s*stable/, 'the detail panels column should own vertical overflow so a tall panel scrolls');
  const settingsCardCss = cssRuleBlock(css, '.settings-card');
  assert.match(settingsCardCss, /border:\s*1px solid var\(--meta-line\)[\s\S]*border-radius:\s*var\(--radius-card\)[\s\S]*background:\s*var\(--meta-panel\)[\s\S]*box-shadow:\s*0 0 0 1px var\(--meta-line\), 0 12px 30px var\(--meta-shadow\)[\s\S]*display:\s*grid[\s\S]*align-content:\s*start/, 'settings card should be a deep-night moonlight panel with a starlight hairline (token-only), sitting directly on the night ground');
  assert.doesNotMatch(settingsCardCss, /overflow-y:\s*auto/, 'individual settings cards should no longer own vertical overflow; the detail panels column does');
  assert.match(css, /\.settings-inline-status,[\s\S]*\.settings-base-url,[\s\S]*\.settings-model-status\s*\{[\s\S]*color:\s*var\(--meta-silver\)[\s\S]*overflow-wrap:\s*anywhere/, 'settings status, derived URL, and model status text should wrap while consuming the moonlight silver token');
  assert.match(css, /\.settings-radio-group\s*\{[\s\S]*border:\s*1px solid var\(--meta-line\)[\s\S]*border-radius:\s*var\(--radius-panel-compact\)[\s\S]*background:\s*var\(--meta-panel-strong\)/, 'settings radio group should consume the moonlight silver-hairline + panel tokens');
  assert.match(css, /\.settings-model-block\s*\{[\s\S]*border:\s*1px solid var\(--meta-line\)[\s\S]*border-radius:\s*var\(--radius-panel-compact\)[\s\S]*background:\s*var\(--meta-panel-strong\)/, 'settings model block should consume the moonlight silver-hairline + panel tokens');
  assert.match(css, /\.settings-model-status\s*\{[\s\S]*color:\s*var\(--meta-silver-dim\)/, 'settings model status should consume the dim moonlight silver token');
  // settings-scope chrome consumes var(--meta-*) only: no literal color and no legacy warm/surface token pins
  // (the "literal 色 0 件" test-by-token contract). The zone spans the settings section comment to the next.
  const settingsCssZone = css.match(/── 設定画面（#settings-screen）[\s\S]*?── セーブデータ選択画面/)?.[0] ?? '';
  assert.notEqual(settingsCssZone, '', 'the settings moonlight CSS zone should be locatable');
  assert.doesNotMatch(settingsCssZone, /rgb\(|rgba\(|#[0-9a-fA-F]{3,8}\b|--border-warm|--surface-settings-card|--surface-settings-model-block|--shadow-settings-card|--surface-bigframe|--c-gold|--text-strong|--text-subtle|--text-settings-status|--eyebrow/, 'the settings-scope CSS should consume var(--meta-*) only — no literal color pin and no legacy warm/surface/text token pins');
  assert.match(css, /@media \(max-width:\s*760px\) \{[\s\S]*\.settings-field-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/, 'settings host and port fields should collapse to one column on narrow screens');
  assert.match(css, /\.academy-map-hero\.settings-screen-hero\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto[\s\S]*align-items:\s*start/, 'settings hero should reserve a dedicated right-edge column so the title return button can sit in the top-right corner of the settings area without being overridden by the shared academy-map hero rule');
  assert.match(css, /\.settings-screen-hero-actions\s*\{[\s\S]*justify-items:\s*end[\s\S]*align-self:\s*start/, 'settings hero actions should place the title return button at the upper-right of the whole settings area');
});

test('slot-load screen hides the topbar and uses a viewport-fit internal-scroll slot list', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  const slotLoadBlock = html.match(/<section id="slot-load-screen"[\s\S]*?<section id="world-screen"/)?.[0] ?? '';
  assert.match(slotLoadBlock, /class="slot-load-backdrop"[\s\S]*class="slot-load-content"[\s\S]*class="screen-heading slot-load-screen-heading"[\s\S]*class="slot-load-board"[\s\S]*id="slot-load-list" class="continuity-record-list slot-load-list"/, 'slot-load should use a full-screen night-ground backdrop + content/board/list structure so viewport-fit sizing does not depend on the generic continuity list contract');
  assert.match(slotLoadBlock, /id="slot-load-resume-play"[^>]*>プレイに戻る<[^]*id="back-to-title-screen"[^>]*>タイトルに戻る</, 'slot-load action row should place プレイに戻る to the left of タイトルに戻る');

  assert.match(js, /const screens = \{[\s\S]*'slot-load': document\.querySelector\('#slot-load-screen'\)/, 'browser should keep slot-load as a registered first-class screen');
  assert.match(js, /function showScreen\(name, \{ rerollAcademyMap = false, skipDungeonRefresh = false \} = \{\}\) \{[\s\S]*document\.body\.classList\.toggle\('title-screen-active', name === 'title'\)[\s\S]*document\.body\.classList\.toggle\('slot-load-screen-active', name === 'slot-load'\)/, 'slot-load should toggle a dedicated body state so the topbar can be hidden only on the load screen');
  assert.match(js, /let currentActiveSlotId = null;\s*let slotLoadCanResumePlay = false;/, 'browser should track both the active slot and the load-screen entry context for slot-load resume availability');
  assert.match(slotLoadBlock, /<dialog id="slot-load-delete-confirm-dialog" class="interaction-detail-dialog[^\"]*" aria-labelledby="slot-load-delete-confirm-title">[\s\S]*class="interaction-detail-card[^\"]*">[\s\S]*id="slot-load-delete-confirm-title">セーブデータ削除確認<\/[hH]3>[\s\S]*スロットを削除しますか？[\s\S]*id="slot-load-delete-confirm-submit"[^>]*>削除する<[\s\S]*id="slot-load-delete-confirm-cancel"[^>]*>削除しない</, 'slot-load should include a shared-dialog confirmation modal with the requested delete copy');
  assert.match(js, /let pendingDeleteSlotId = null;/, 'browser should track which slot is awaiting delete confirmation');
  assert.match(js, /function openDeleteSlotDialog\(slotId\) \{[\s\S]*pendingDeleteSlotId = slotId;[\s\S]*document\.body\.classList\.add\('interaction-detail-backdrop'\);[\s\S]*dialog\.showModal\(\)/, 'slot delete should open a native shared dialog and remember the pending slot');
  assert.match(js, /function closeDeleteSlotDialog\(\) \{[\s\S]*pendingDeleteSlotId = null;[\s\S]*dialog\.close\(\)/, 'slot delete cancel path should clear pending state and close the dialog');
  assert.match(js, /async function confirmDeleteSlot\(\) \{[\s\S]*if \(!pendingDeleteSlotId\) return;[\s\S]*const slotId = pendingDeleteSlotId;[\s\S]*closeDeleteSlotDialog\(\);[\s\S]*await deleteSpecificSlot\(slotId\);[\s\S]*\}/, 'slot delete confirm should be the only path that forwards the remembered slot into deleteSpecificSlot');
  assert.match(js, /function canResumeFromSlotLoad\(\) \{[\s\S]*return slotLoadCanResumePlay && Boolean\(currentActiveSlotId\) && !activeSlotIncompatible;[\s\S]*\}/, 'slot-load resume availability should require an active slot, a play-resumable load-screen entry context, and a compatible (non-degraded) active slot');
  assert.match(js, /function updateSlotLoadResumeButton\(\) \{[\s\S]*#slot-load-resume-play[\s\S]*disabled = !canResumeFromSlotLoad\(\)/, 'slot-load should actively synchronize the resume button disabled state');
  assert.match(js, /async function refreshSaveSlots\(\) \{[\s\S]*currentActiveSlotId = response\.active_slot_id \?\? null;[\s\S]*updateSlotLoadResumeButton\(\)/, 'slot refresh should update active-slot knowledge before syncing the resume button');
  assert.match(js, /remove\.addEventListener\('click', \(\) => openDeleteSlotDialog\(slot\.slot_id\)\)/, 'slot card delete button should open the confirmation dialog instead of deleting immediately');
  assert.doesNotMatch(js, /remove\.addEventListener\('click', \(\) => deleteSpecificSlot\(slot\.slot_id\)\.catch\(reportError\)\)/, 'slot card delete button must no longer call deleteSpecificSlot directly');
  assert.match(js, /#slot-load-delete-confirm-submit[\s\S]*addEventListener\('click', \(\) => confirmDeleteSlot\(\)\.catch\(reportError\)\)/, 'delete confirmation submit button should be wired through the confirm helper');
  assert.match(js, /#slot-load-delete-confirm-cancel[\s\S]*addEventListener\('click', \(\) => closeDeleteSlotDialog\(\)\)/, 'delete confirmation cancel button should be wired through the close helper');
  assert.match(js, /#slot-load-delete-confirm-dialog'\)\.addEventListener\('close', \(\) => \{[\s\S]*pendingDeleteSlotId = null;[\s\S]*document\.body\.classList\.remove\('interaction-detail-backdrop'\);[\s\S]*}\)/, 'delete confirmation dialog close event should clear pending state and shared backdrop state');
  assert.match(js, /#slot-load-resume-play[\s\S]*addEventListener\('click', \(\) => resumePlayFromSlotLoad\(\)\.catch\(reportError\)\)/, 'slot-load resume button should be wired through a dedicated browser-side resume helper');
  assert.match(js, /async function resumePlayFromSlotLoad\(\) \{[\s\S]*if \(!canResumeFromSlotLoad\(\)\) return;[\s\S]*document\.body\.classList\.add\('play-mode'\);[\s\S]*showScreen\('academy-room'\);[\s\S]*\}/, 'slot-load resume should return directly to academy-room without calling the slot-load API again');
  assert.doesNotMatch(js.match(/async function resumePlayFromSlotLoad\([\s\S]*?\n}\n/)?.[0] ?? '', /\/api\/slots\/load|loadSpecificSlot\(/, 'slot-load resume must not trigger a fresh slot load');

  assert.match(css, /body\.slot-load-screen-active \.topbar\s*\{[\s\S]*display:\s*none/, 'slot-load should hide the topbar while active');
  assert.match(css, /body\.slot-load-screen-active \.layout\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*none[\s\S]*height:\s*100dvh[\s\S]*min-height:\s*100dvh[\s\S]*margin:\s*0[\s\S]*padding:\s*0[\s\S]*overflow:\s*hidden/, 'slot-load layout should fill the viewport like a focused entry screen once the topbar is hidden');
  assert.match(css, /#slot-load-screen\.active\s*\{[\s\S]*display:\s*grid[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'slot-load active screen should fill the bounded layout height');
  // The full-screen night ground now provides the viewport-fit chain (no shell/card window wrapper): the content
  // layer reserves the heading height and gives the remainder to the board, which owns the internal scroll.
  assert.doesNotMatch(css, /\.slot-load-shell\s*\{|\.slot-load-card\s*\{/, 'the old warm shell/card window rules should be removed without a trace');
  const slotLoadContentCss = cssRuleBlock(css, '.slot-load-content');
  assert.match(slotLoadContentCss, /display:\s*grid[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'slot-load content should reserve heading height and give the remainder to the board');
  const slotLoadBoardCss = cssRuleBlock(css, '.slot-load-board');
  assert.match(slotLoadBoardCss, /display:\s*grid[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/, 'slot-load board should bound the save-slot list in the remaining height');
  assert.match(css, /\.slot-load-list\s*\{[\s\S]*max-height:\s*none[\s\S]*height:\s*100%[\s\S]*min-height:\s*0[\s\S]*overflow-y:\s*auto/, 'slot-load list should own overflow and no longer use the shared fixed-height cap');
  // The memory-card note column now reads as night chrome (silver hairline + silver text), matching the meta
  // moonlight layer; the previous warm-gold separators and cream note-label token are gone without a trace.
  assert.match(cssRuleBlock(css, '.slot-load-note-editor'), /border-left:\s*1px solid var\(--meta-line\)/, 'slot-load note editor should consume the moonlight silver hairline');
  assert.match(cssRuleBlock(css, '.slot-load-note-label'), /color:\s*var\(--meta-silver\)/, 'slot-load note label should read as moonlight silver');
  assert.match(cssRuleBlock(css, '.slot-load-note-status'), /color:\s*var\(--meta-silver-dim\)/, 'slot-load note status should read as sunken moonlight silver');
  assert.match(css, /@media \(max-width:\s*980px\) \{[\s\S]*\.slot-load-note-editor\s*\{[\s\S]*border-top:\s*1px solid var\(--meta-line\)/, 'slot-load narrow note separator should use the moonlight silver hairline');
  assert.doesNotMatch(css, /--text-slot-note-label/, 'the dead slot-note-label token should be removed once the note column is night chrome');
  assert.doesNotMatch(cssRuleBlock(css, '.slot-load-list'), /max-height:\s*260px/, 'slot-load must not keep the old 260px slot-list ceiling');
});

test('live public slot-load surface requires a delete confirmation dialog before deleteSpecificSlot', async () => {
  const html = await readFile(path.join(projectRoot, 'app/public/index.html'), 'utf8');
  const js = await readFile(path.join(projectRoot, 'app/public/app.js'), 'utf8');

  assert.match(html, /<dialog id="slot-load-delete-confirm-dialog" class="interaction-detail-dialog[^\"]*" aria-labelledby="slot-load-delete-confirm-title">[\s\S]*class="interaction-detail-card[^\"]*">[\s\S]*id="slot-load-delete-confirm-title">セーブデータ削除確認<\/[hH]3>[\s\S]*スロットを削除しますか？[\s\S]*id="slot-load-delete-confirm-submit"[^>]*>削除する<[\s\S]*id="slot-load-delete-confirm-cancel"[^>]*>削除しない</, 'live public index should expose the requested shared-dialog delete confirmation');
  assert.match(js, /let pendingDeleteSlotId = null;/, 'live public app should track which slot is awaiting delete confirmation');
  assert.match(js, /function openDeleteSlotDialog\(slotId\) \{[\s\S]*pendingDeleteSlotId = slotId;[\s\S]*document\.body\.classList\.add\('interaction-detail-backdrop'\);[\s\S]*dialog\.showModal\(\)/, 'live public app should open the shared dialog and remember the pending slot');
  assert.match(js, /function closeDeleteSlotDialog\(\) \{[\s\S]*pendingDeleteSlotId = null;[\s\S]*dialog\.close\(\)/, 'live public app should clear pending state when the dialog closes');
  assert.match(js, /async function confirmDeleteSlot\(\) \{[\s\S]*if \(!pendingDeleteSlotId\) return;[\s\S]*const slotId = pendingDeleteSlotId;[\s\S]*closeDeleteSlotDialog\(\);[\s\S]*await deleteSpecificSlot\(slotId\);[\s\S]*\}/, 'live public app should route confirmed delete through deleteSpecificSlot only after confirmation');
  assert.match(js, /remove\.addEventListener\('click', \(\) => openDeleteSlotDialog\(slot\.slot_id\)\)/, 'live public slot delete button should open the dialog instead of deleting immediately');
  assert.doesNotMatch(js, /remove\.addEventListener\('click', \(\) => deleteSpecificSlot\(slot\.slot_id\)\.catch\(reportError\)\)/, 'live public slot delete button must not call deleteSpecificSlot directly');
});

test('settings screen exposes only the conversation popup cooldown preset (animation + landing presets removed), persisting server-side', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  // Only the cooldown preset remains (3+ steps). The animation-speed and academy-screen presets are removed.
  assert.match(html, /id="conv-popup-cooldown-preset"/, 'settings should expose a cooldown preset selector');
  assert.doesNotMatch(html, /id="conv-popup-animation-preset"|id="conv-popup-academy-screen-preset"/, 'the animation-speed and academy-screen presets are removed from the markup');
  const cooldownSelect = html.match(/<select id="conv-popup-cooldown-preset">[\s\S]*?<\/select>/)?.[0] ?? '';
  assert.ok((cooldownSelect.match(/<option/g) ?? []).length >= 3, 'cooldown should offer at least three presets');
  assert.match(cooldownSelect, /<option value="500" selected>/, 'cooldown should default to the standard 500ms preset');
  assert.match(cooldownSelect, /<option value="300">/, 'cooldown presets should include a value shorter than the 500ms standard');
  assert.match(cooldownSelect, /<option value="120">/, 'cooldown presets should include a clearly faster (shorter) value than 500ms');

  // The UI preset option values must exactly match the server-accepted preset contract (the server rejects
  // any non-preset value), so neither side drifts.
  const optionValues = (select) => (select.match(/value="(\d+)"/g) ?? []).map((match) => Number(match.match(/\d+/)[0]));
  assert.deepEqual(
    optionValues(cooldownSelect).sort((a, b) => a - b),
    [...CONVERSATION_POPUP_COOLDOWN_PRESETS].sort((a, b) => a - b),
    'cooldown preset options must match the server-accepted cooldown presets exactly'
  );

  // Persistence follows the existing server-side settings mechanism (GET/PATCH), now a cooldown-only contract.
  assert.match(js, /getJson\('\/api\/settings\/conversation-popup'\)/, 'settings should load the persisted popup preferences from the server on demand');
  assert.match(js, /patchJson\('\/api\/settings\/conversation-popup', \{/, 'changing a preset should persist it through the server settings endpoint (via the shared patchJson so a non-OK response carries the server error body)');
  assert.match(js, /async function loadConversationPopupSettings\(\)/, 'browser should centralize loading the persisted popup preferences');
  assert.match(js, /async function saveConversationPopupSettings\(\)/, 'browser should centralize persisting the popup preferences');
  assert.match(js, /patchJson\('\/api\/settings\/conversation-popup', \{\s*\n\s*cooldown_ms: Number\(cooldown\?\.value\)\s*\n\s*\}\)/, 'saving the popup settings should PATCH only cooldown_ms');
  // A failed save must drive the category status to a terminal error (concrete reason) instead of leaving
  // it stuck on 保存中です, then rethrow to reportError. The three failure modes are covered in
  // settingsSaveError.test.mjs; here we guard the catch wiring + rethrow.
  assert.match(js, /async function saveConversationPopupSettings\(\)\s*\{[\s\S]*?setConversationPopupSettingsStatus\('保存中です。'\);[\s\S]*?try \{[\s\S]*?patchJson\('\/api\/settings\/conversation-popup'[\s\S]*?\} catch \(error\) \{\s*setConversationPopupSettingsStatus\(settingsSaveErrorMessage\(error, '会話ポップアップ'\)\);\s*throw error;\s*\}/, 'saveConversationPopupSettings should surface a failure as a terminal category error and rethrow to reportError');
  assert.match(js, /function applyConversationPopupSettings\(settings\)\s*\{[\s\S]*?conversationPopupSettings\.cooldown_ms = cooldownMs;[\s\S]*?\n\}/, 'applied settings store only the cooldown');
  assert.doesNotMatch(js, /animation_ms|academy_conversation_screen|conversationPopupAnimationMs|applyConversationPopupAnimation|function academyConversationLandingScreen/, 'the animation preference + academy landing preference are removed from the browser script');
  // The chat-bubble pop-in is a fixed 220ms declared once in CSS; nothing overrides the CSS variable from JS.
  assert.match(css, /--bubble-pop-in-duration:\s*220ms;/, 'the pop-in duration is a fixed 220ms CSS variable');
  assert.doesNotMatch(js, /setProperty\('--bubble-pop-in-duration'/, 'the browser script must not drive the pop-in duration from a setting (it is fixed in CSS)');
  // Applied at boot so persisted preferences are active before the settings screen is opened.
  assert.match(js, /loadConversationPopupSettings\(\)\n\]\)\.then\(\(\) => applyInitialScreenOverride\(\)\)/, 'persisted popup preferences should load during startup');
  assert.match(js, /document\.querySelector\('#conv-popup-cooldown-preset'\)\.addEventListener\('change', \(\) => saveConversationPopupSettings\(\)\.catch\(reportError\)\)/, 'changing the cooldown preset should immediately persist the selection');
});

test('settings screen adds a サウンド (audio) category: BGM on/off + volume, on-change PATCH /api/settings/audio, token-only chrome', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(path.join(root, 'style.css'), 'utf8');

  // Nav tab labelled サウンド, controlling the audio panel; it follows the existing three category tabs.
  assert.match(html, /<button id="settings-category-audio" type="button" class="settings-category-tab" data-settings-category="audio" aria-controls="settings-panel-audio" aria-pressed="false">サウンド<\/button>/, 'the settings nav should expose a サウンド category tab controlling the audio panel');
  // The audio panel is a standard master-detail category panel, hidden by default (LM Studio is the default).
  const audioPanel = html.match(/<section id="settings-panel-audio"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(audioPanel, '', 'the audio settings panel is present');
  assert.match(audioPanel, /class="settings-card settings-category-panel" data-settings-category="audio" aria-labelledby="audio-settings-title" hidden>/, 'the audio panel is a hidden-by-default settings category panel');
  assert.match(audioPanel, /<input id="audio-bgm-enabled" type="checkbox" \/>/, 'the audio panel has a BGM on/off toggle');
  assert.match(audioPanel, /<input id="audio-bgm-volume" type="range" min="0" max="1" step="0\.01" \/>/, 'the audio panel has a 0..1 master-volume slider');

  // The category is a member of the closed category set, so selectSettingsCategory('audio') is a valid selection.
  assert.match(js, /const SETTINGS_CATEGORIES = \['lmstudio', 'conversation-popup', 'conversation-finalize', 'audio'\]/, 'audio should be a member of the closed settings category set');

  // Loaders / savers mirror the other categories.
  assert.match(js, /async function loadAudioSettings\(\) \{[\s\S]*getJson\('\/api\/settings\/audio'\)[\s\S]*bgmController\.applyAudioSettings\(settings\);[\s\S]*renderAudioSettings\(settings\);/, 'loadAudioSettings GETs the disk values and applies them to the controller + controls');
  assert.match(js, /async function saveAudioSettings\(update\) \{[\s\S]*patchJson\('\/api\/settings\/audio', update\)[\s\S]*bgmController\.applyAudioSettings\(saved\);/, 'saveAudioSettings PATCHes the changed field and applies the persisted response to the controller');
  // A failed save must drive the category status to a terminal error (concrete reason) instead of leaving
  // it stuck on 保存中です, then rethrow to reportError. applyAudioSettings is strict and throws on a
  // malformed success body, so that failure mode also lands in the catch. The three failure modes are
  // covered in settingsSaveError.test.mjs; here we guard the catch wiring + rethrow.
  assert.match(js, /async function saveAudioSettings\(update\) \{[\s\S]*?setAudioSettingsStatus\('保存中です。'\);[\s\S]*?try \{[\s\S]*?patchJson\('\/api\/settings\/audio', update\)[\s\S]*?\} catch \(error\) \{\s*setAudioSettingsStatus\(settingsSaveErrorMessage\(error, '音声'\)\);\s*throw error;\s*\}/, 'saveAudioSettings should surface a failure as a terminal category error and rethrow to reportError');
  // openSettingsScreen loads the audio settings on every entry (entry-independent display).
  assert.match(js, /function openSettingsScreen\(\)\s*\{[\s\S]*loadAudioSettings\(\)\.catch\(reportError\)[\s\S]*renderRoutingFinalizePanel\(\);/, 'opening the settings screen should load the audio settings regardless of entry');
  // On-change apply (no save button): toggle → bgm_enabled, slider → bgm_volume; failures go to reportError.
  assert.match(js, /document\.querySelector\('#audio-bgm-enabled'\)\.addEventListener\('change', \(event\) => saveAudioSettings\(\{ bgm_enabled: event\.target\.checked \}\)\.catch\(reportError\)\)/, 'toggling BGM should immediately PATCH bgm_enabled');
  assert.match(js, /document\.querySelector\('#audio-bgm-volume'\)\.addEventListener\('change', \(event\) => saveAudioSettings\(\{ bgm_volume: Number\(event\.target\.value\) \}\)\.catch\(reportError\)\)/, 'changing the volume should immediately PATCH bgm_volume');

  // Token-only chrome for the added audio controls (var(--meta-*) only — no literal color pin).
  const toggleFieldCss = cssRuleBlock(css, '.settings-toggle-field');
  assert.match(toggleFieldCss, /grid-template-columns:\s*1fr auto[\s\S]*align-items:\s*center/, 'the toggle field lays the label and checkbox in one row');
  assert.match(css, /#settings-screen \.settings-content \.settings-field input\[type='checkbox'\],\n#settings-screen \.settings-content \.settings-field input\[type='range'\] \{[\s\S]*accent-color:\s*var\(--meta-starlight\)/, 'the audio controls read moonlight via the starlight accent token');
});

test('slot-load cards render a dedicated per-slot memo column and preserve slot-level note APIs', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const saveLoad = await readFile(`${sourceRoot}/saveLoad.mjs`, 'utf8');
  const server = await readFile(`${sourceRoot}/server.mjs`, 'utf8');

  assert.match(js, /const SLOT_LOAD_NOTE_MAX_LENGTH = 2000;/, 'slot-load memo editor should allow around 2000 characters in the browser too');
  assert.match(js, /function renderSlotNoteEditor\(slot\)[\s\S]*heading\.textContent = 'メモ'[\s\S]*textarea[\s\S]*textarea\.name = `player_note_\$\{slot\.slot_id\}`[\s\S]*textarea\.maxLength = SLOT_LOAD_NOTE_MAX_LENGTH/, 'slot-load cards should render a dedicated note textarea per slot');
  assert.match(js, /function renderSlotNoteEditor\(slot\)[\s\S]*addEventListener\('blur',[\s\S]*saveSlotNote\(slot\.slot_id, textarea\.value\)/, 'slot memo should save on blur from the slot-specific textarea');
  assert.match(js, /async function saveSlotNote\(slotId, playerNote\)[\s\S]*\/api\/slots\/\$\{encodeURIComponent\(slotId\)\}\/note/, 'slot memo save should use a dedicated slot-note API');
  assert.match(js, /article\.className = 'continuity-record-item slot-load-item'[\s\S]*const body = document\.createElement\('div'\);[\s\S]*body\.className = 'slot-load-item-body'/, 'slot-load cards should split content into a left summary block and a right memo block');
  assert.match(js, /const graduationStatus = document\.createElement\('p'\);[\s\S]*graduationStatus\.className = 'slot-load-item-status';[\s\S]*graduationStatus\.textContent = '卒業済み';[\s\S]*graduationStatus\.hidden = slot\.graduation_completed !== true;/, 'slot-load summary should render a dedicated 卒業済み status line only for graduated slots');
  assert.match(js, /load\.disabled = slot\.graduation_completed === true;[\s\S]*load\.setAttribute\('aria-disabled', String\(slot\.graduation_completed === true\)\)/, 'graduated slot start buttons should be natively disabled and expose the same state to accessibility helpers');

  assert.match(css, /\.slot-load-item-body\s*\{[\s\S]*grid-template-columns:\s*minmax\(280px, 3fr\) minmax\(0, 7fr\)/, 'slot-load cards should devote most of the wide row to the memo column');
  assert.match(css, /\.slot-load-list\s*\{[\s\S]*gap:\s*14px[\s\S]*overflow-y:\s*auto/, 'slot-load list should space the discrete memory cards with a gap rather than a continuous ledger');
  const slotItemPanelCss = cssRuleBlock(css, '.slot-load-item');
  assert.match(slotItemPanelCss, /border:\s*1px solid var\(--meta-line\)[\s\S]*border-radius:\s*var\(--radius-card\)/, 'each slot should be a discrete memory-card panel (silver hairline + card radius) instead of a divider-separated ledger row');
  assert.doesNotMatch(css, /\.slot-load-item \+ \.slot-load-item\s*\{[\s\S]*border-top/, 'the old between-row divider must be gone now that slots are discrete cards');
  assert.match(css, /\.slot-load-note-editor\s*\{[\s\S]*border-left:\s*1px solid/, 'slot memo column should be visually separated from the save summary within the same slot');
  assert.match(css, /\.slot-load-note-editor textarea\s*\{[\s\S]*resize:\s*vertical[\s\S]*min-height:\s*96px/, 'slot memo textarea should be editable and tall enough for identification notes');
  assert.match(css, /\.slot-load-item-status\s*\{[\s\S]*font-size:\s*12px/, 'graduated slot status text should use a compact secondary line in the slot summary');
  assert.match(css, /#slot-load-screen \.slot-load-item-summary p\.slot-load-item-status\s*\{[\s\S]*color:\s*var\(--meta-silver-dim\)/, 'graduated slot status text should read as sunken moonlight silver in the night theme');
  assert.match(css, /\.slot-load-item-summary \.dialog-action-row\s*\{[\s\S]*margin-top:\s*14px/, 'slot-load should add explicit vertical spacing between the description\/status area and the start button row');

  assert.match(saveLoad, /player_note:\s*meta\.player_note \?\? ''[\s\S]*graduation_completed:\s*meta\.graduation_completed === true/, 'slot summaries should preserve player notes while exposing graduation_completed');
  assert.match(saveLoad, /const slotNoteRoutePattern = \^\\\/api\\\/slots\\\/\[\^\/\]\+\\\/note\$\|slotNoteRoutePattern\.test\(url\.pathname\)|updateSaveSlotNote/, 'save-load API should expose a dedicated slot-note update route and handler');
});

// task incompatible-slot-degraded-ui-frontend — the load screen consumes the backend degraded contract
// (GET /api/slots 200 + incompatible_slots + active_slot_incompatible). Incompatible slots render as
// degraded cards: a fixed player-facing reason (no migration CLI text), safely readable metadata, and the
// shared delete-confirm dialog ONLY — no start button and no note editor. (Source-regex UI test; the live
// title→ロード→degraded card→delete flow is the Electron harness app/tests/manual/slotLoadDegradedRender.mjs.)
test('slot-load renders incompatible slots as delete-only degraded cards from the backend degraded contract', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // The degraded reason shown to the player is a fixed explanation, NOT the server compatibility.message
  // (which embeds the developer migration CLI command). It never mentions the migration script.
  assert.match(js, /const SLOT_LOAD_DEGRADED_REASON = '旧バージョンのセーブデータのため読み込めません。削除のみ可能です。';/, 'the degraded reason should be a fixed player-facing explanation constant');
  // The degraded card renders the fixed reason constant, never the server compatibility.message (which embeds
  // the migration CLI command). Scope the CLI-absence check to the card renderer — app.js legitimately names the
  // command once in the constant's explaining comment.
  assert.doesNotMatch(fn('renderDegradedSlotCard'), /stamp-slot-play-mode|compatibility\.message|entry\.compatibility/, 'the degraded card must not render the server compatibility.message / migration CLI text');

  // refreshSaveSlots reads BOTH lists and branches the route resolution on active_slot_incompatible so the
  // null play-mode / phase-2 fields of a degraded active slot never reach the fail-fast route resolver.
  const refresh = fn('refreshSaveSlots');
  assert.match(refresh, /const incompatibleSlots = response\.incompatible_slots \?\? \[\];/, 'refreshSaveSlots should read the incompatible_slots list from the contract');
  assert.match(refresh, /activeSlotIncompatible = response\.active_slot_incompatible === true;/, 'refreshSaveSlots should track the active_slot_incompatible flag');
  assert.match(refresh, /if \(activeSlotIncompatible\) \{[\s\S]*slotLoadEntryRoute = null;[\s\S]*slotLoadGraduationPhase2Reentry = null;[\s\S]*currentPlayMode = null;[\s\S]*\} else \{[\s\S]*slotLoadEntryRoute = resolvePlayModeEntryRoute\(response, '\/api\/slots'\);/, 'a degraded active slot should null the route/phase-2 contract instead of resolving them (avoiding the fail-fast on null fields)');
  // The load screen stays reachable while a degraded card remains (so it can be deleted), even with no
  // compatible slot left; the empty state only appears when BOTH lists are empty.
  assert.match(refresh, /if \(loadButton\) loadButton\.disabled = slots\.length === 0 && incompatibleSlots\.length === 0;/, 'the title load button should stay enabled while any degraded card remains');
  assert.match(refresh, /if \(!slots\.length && !incompatibleSlots\.length\) \{[\s\S]*continuity-empty/, 'the empty state should only render when there are neither compatible nor degraded slots');
  assert.match(refresh, /\.\.\.slots\.map\(\(slot\) => renderSlotCard\(slot\)\),\s*\n\s*\.\.\.incompatibleSlots\.map\(\(entry\) => renderDegradedSlotCard\(entry\)\)/, 'the list should render normal cards then degraded cards');
  assert.match(refresh, /return \{ slots, incompatibleSlots \};/, 'refreshSaveSlots should return both lists so callers can decide the empty→title transition');

  // The degraded card offers delete only — no start button, no note editor — routed through the same
  // confirmation dialog as normal cards.
  const degraded = fn('renderDegradedSlotCard');
  assert.match(degraded, /article\.className = 'continuity-record-item slot-load-item slot-load-item-degraded';/, 'the degraded card should carry its distinguishing class');
  assert.match(degraded, /reason\.textContent = SLOT_LOAD_DEGRADED_REASON;/, 'the degraded card should show the fixed player-facing reason');
  assert.match(degraded, /remove\.addEventListener\('click', \(\) => openDeleteSlotDialog\(entry\.slot_id\)\)/, 'the degraded delete button should open the shared confirmation dialog');
  assert.doesNotMatch(degraded, /loadSpecificSlot|このデータで始める/, 'the degraded card must not offer a load / start button');
  assert.doesNotMatch(degraded, /renderSlotNoteEditor|saveSlotNote/, 'the degraded card must not offer a note editor');

  // Delete stays on the load screen while any degraded card remains; title only on a fully empty listing.
  assert.match(fn('deleteSpecificSlot'), /const \{ slots, incompatibleSlots \} = await refreshSaveSlots\(\);\s*\n\s*if \(!slots\.length && !incompatibleSlots\.length\) showScreen\('title'\);/, 'delete should return to title only when neither a compatible nor a degraded slot remains');

  // resume ("プレイに戻る") is disabled for a degraded active slot (no resumable play session).
  assert.match(js, /let activeSlotIncompatible = false;/, 'the active-slot incompatibility flag should be module state');
  assert.match(fn('canResumeFromSlotLoad'), /return slotLoadCanResumePlay && Boolean\(currentActiveSlotId\) && !activeSlotIncompatible;/, 'resume availability should require the active slot not be incompatible');

  // Degraded card chrome: sunken night ground, no starlight resume-flare on hover/focus (it is not selectable).
  const degradedCss = cssRuleBlock(css, '.slot-load-item.slot-load-item-degraded');
  assert.match(degradedCss, /background:\s*var\(--meta-night-1\)/, 'the degraded card should sit on a sunken night ground token');
  assert.match(css, /\.slot-load-item\.slot-load-item-degraded:hover,\n\.slot-load-item\.slot-load-item-degraded:focus-within \{[\s\S]*border-color:\s*var\(--meta-line\)/, 'the degraded card should not flare a starlight selectable border on hover/focus');
  assert.match(css, /#slot-load-screen \.slot-load-item-summary p\.slot-load-item-degraded-reason \{[\s\S]*color:\s*var\(--meta-silver\)/, 'the degraded reason line should read as moonlight silver');
});
